import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import {
  chatWithMimirCouncil,
  loadMimirCouncilContext,
  type MimirChatMessage,
} from '@/lib/agents/mimir-council'

export const maxDuration = 60

/**
 * POST /api/experiments/mimir
 *
 * Body:
 *  - conversationId?: string   (load + append, otherwise create fresh)
 *  - message:         string   (user's prompt)
 *
 * Returns: { conversationId, messages, latestProposals }
 *
 * The endpoint is intentionally chat-shaped (one user message → one
 * assistant message + parsed proposals) so the UI can stream a familiar
 * thread. Conversations persist in mimir_conversations.messages JSONB —
 * each entry includes `proposals` so reloading shows existing "Add as
 * experiment" CTAs without re-running the model.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  const { conversationId, message } = body
  if (!message?.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 })

  // Resolve site → display name + domain (Mimir's prompt cites the brand)
  let siteName = 'G2G'
  let domain   = 'g2g.com'
  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    domain = site.domain
    const { data: cfg } = await db
      .from('site_configs')
      .select('display_name')
      .eq('slug', siteSlug)
      .maybeSingle()
    siteName = String(cfg?.display_name ?? siteSlug.toUpperCase())
  } catch {
    // Fall back to defaults — Mimir still works, just less branded
  }

  // Load or create conversation
  let convo: { id: string; messages: MimirChatMessage[]; title: string } | null = null
  if (conversationId) {
    const { data } = await db
      .from('mimir_conversations')
      .select('id, messages, title')
      .eq('id', conversationId)
      .eq('owner_user_id', ownerId)
      .maybeSingle()
    if (data) {
      convo = {
        id:       String(data.id),
        title:    String(data.title),
        messages: (data.messages as MimirChatMessage[] | null) ?? [],
      }
    }
  }

  if (!convo) {
    // Title: derive from first user message (truncated). Avoid LLM call here
    // — saves latency + cost on the very first request.
    const seedTitle = message.slice(0, 60).trim() + (message.length > 60 ? '…' : '')
    const { data, error } = await db
      .from('mimir_conversations')
      .insert({
        owner_user_id: ownerId,
        site_slug:     siteSlug,
        title:         seedTitle || 'New conversation',
        messages:      [],
      })
      .select('id, messages, title')
      .single()
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Failed to create conversation' }, { status: 500 })
    }
    convo = {
      id:       String(data.id),
      title:    String(data.title),
      messages: [],
    }
  }

  // Build context + run Mimir
  const context = await loadMimirCouncilContext({ db, ownerId, siteSlug, siteName, domain })

  let reply: string
  let proposals: import('@/lib/agents/mimir-council').ExperimentProposal[]
  try {
    const out = await chatWithMimirCouncil({ context, history: convo.messages, userMessage: message })
    reply = out.reply
    proposals = out.proposals
  } catch (e) {
    return NextResponse.json({
      error:  'Mimir is silent — Anthropic API error',
      detail: e instanceof Error ? e.message : String(e),
    }, { status: 502 })
  }

  // Append both messages
  const now = new Date().toISOString()
  const newMessages: MimirChatMessage[] = [
    ...convo.messages,
    { role: 'user',      content: message, ts: now },
    { role: 'assistant', content: reply,   ts: new Date().toISOString(), proposals },
  ]

  const { error: saveErr } = await db
    .from('mimir_conversations')
    .update({ messages: newMessages })
    .eq('id', convo.id)
    .eq('owner_user_id', ownerId)

  if (saveErr) {
    // Non-fatal — return the reply anyway; user can copy it. Log loudly.
    console.error('[mimir] save failed:', saveErr)
  }

  return NextResponse.json({
    conversationId: convo.id,
    title:          convo.title,
    messages:       newMessages,
    latestProposals: proposals,
  })
}

/**
 * GET /api/experiments/mimir?conversationId=...
 *   → load a single conversation
 * GET /api/experiments/mimir
 *   → list recent conversations for the active site
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const id       = url.searchParams.get('conversationId')
  const db       = createServiceClient()

  if (id) {
    const { data, error } = await db
      .from('mimir_conversations')
      .select('id, title, messages, updated_at')
      .eq('id', id)
      .eq('owner_user_id', ownerId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ conversation: data })
  }

  const { data, error } = await db
    .from('mimir_conversations')
    .select('id, title, updated_at, pinned')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ conversations: data ?? [] })
}

/** DELETE /api/experiments/mimir?conversationId=... */
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const id = new URL(req.url).searchParams.get('conversationId')
  if (!id) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

  const { error } = await supabase
    .from('mimir_conversations')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
