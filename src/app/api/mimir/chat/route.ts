import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import { loadPageContext, type PageContext } from '@/lib/agents/mimir-context'
import {
  filterDuplicateProposals,
  type ExperimentProposal,
  type MimirChatMessage,
} from '@/lib/agents/mimir-council'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MIMIR_MODEL = 'claude-sonnet-4-6'

/**
 * POST /api/mimir/chat
 *
 * Unified chat endpoint for Mimir Level B. The frontend passes:
 *   { conversationId?, message, pageContext: { kind, ...args } }
 *
 * Server resolves the appropriate context loader for `pageContext.kind`,
 * builds a kind-specific system prompt + data block, runs Sonnet, persists
 * to mimir_conversations (with page_context preserved for thread grouping).
 *
 * The legacy /api/experiments/mimir is kept as a thin alias that calls
 * THIS route with `pageContext: { kind: 'experiments' }` — see that file.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db = createServiceClient()

  const { conversationId, message } = body
  if (!message?.trim()) return NextResponse.json({ error: 'message required' }, { status: 400 })

  const pageContext: PageContext = (body.pageContext && typeof body.pageContext === 'object')
    ? body.pageContext
    : { kind: 'experiments' }    // back-compat default

  // Resolve site → display name + domain (Mimir's prompt cites the brand)
  let siteName = siteSlug.toUpperCase()
  let domain   = `${siteSlug}.com`
  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    domain = site.domain
    const { data: cfg } = await db
      .from('site_configs')
      .select('display_name')
      .eq('slug', siteSlug)
      .maybeSingle()
    siteName = String(cfg?.display_name ?? siteName)
  } catch {
    // Fall back to defaults — Mimir still works
  }

  // Load or create conversation. We scope by page_context.kind + id when
  // present, so the user's "Mimir on April Monthly Report" thread stays
  // separate from "Mimir on Experiments".
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
    const seedTitle = message.slice(0, 60).trim() + (message.length > 60 ? '…' : '')
    const { data, error } = await db
      .from('mimir_conversations')
      .insert({
        owner_user_id: ownerId,
        site_slug:     siteSlug,
        title:         seedTitle || 'New conversation',
        messages:      [],
        page_context:  pageContext,
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

  // ── Resolve page context → system prompt + flags ──────────────────────────
  const ctxResult = await loadPageContext({
    db, ownerId, siteSlug, siteName, domain, ctx: pageContext,
  })

  // ── Build Anthropic message thread ─────────────────────────────────────────
  const anthropicMessages: Anthropic.MessageParam[] = []
  for (const m of convo.messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      anthropicMessages.push({ role: m.role, content: m.content })
    }
  }
  anthropicMessages.push({ role: 'user', content: message })

  let reply: string
  let proposals: ExperimentProposal[] = []
  let duplicatesFiltered: Array<{ proposal: ExperimentProposal; matchedTitle: string; similarity: number }> = []
  try {
    const res = await anthropic.messages.create({
      model:      MIMIR_MODEL,
      max_tokens: 2400,
      system:     ctxResult.systemPrompt,
      messages:   anthropicMessages,
    })
    reply = res.content[0]?.type === 'text' ? res.content[0].text : ''

    // Only parse experiment proposals when this kind of context expects them
    if (ctxResult.parseProposals) {
      const raw = parseExperimentProposals(reply)

      // Hard-filter duplicates against active + past experiments. Mimir
      // sometimes re-proposes ideas it's already had — annoying for the
      // user. We compare title token-sets via Jaccard ≥ 0.7.
      const { data: existing } = await db
        .from('experiments')
        .select('title')
        .eq('owner_user_id', ownerId)
        .eq('site_slug', siteSlug)
      const existingTitles = (existing ?? []).map(e => String(e.title))
      const { kept, rejected } = filterDuplicateProposals(raw, existingTitles)
      proposals = kept
      duplicatesFiltered = rejected
    }
  } catch (e) {
    return NextResponse.json({
      error:  'Mimir is silent — Anthropic API error',
      detail: e instanceof Error ? e.message : String(e),
    }, { status: 502 })
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const newMessages: MimirChatMessage[] = [
    ...convo.messages,
    { role: 'user',      content: message, ts: now },
    { role: 'assistant', content: reply,   ts: new Date().toISOString(), proposals },
  ]

  const { error: saveErr } = await db
    .from('mimir_conversations')
    .update({ messages: newMessages, page_context: pageContext })
    .eq('id', convo.id)
    .eq('owner_user_id', ownerId)

  if (saveErr) console.error('[mimir-chat] save failed:', saveErr)

  return NextResponse.json({
    conversationId:  convo.id,
    title:           convo.title,
    messages:        newMessages,
    latestProposals: proposals,
    duplicatesFiltered: duplicatesFiltered.map(d => ({
      title:        d.proposal.title,
      matchedTitle: d.matchedTitle,
      similarity:   Math.round(d.similarity * 100) / 100,
    })),
    contextLabel:    ctxResult.contextLabel,
    quickPrompts:    ctxResult.quickPrompts,
    parseProposals:  ctxResult.parseProposals,
  })
}

/**
 * GET /api/mimir/chat
 *   ?conversationId=...     — load a single conversation
 *   ?kind=...&id=...        — list conversations for a page (kind required)
 *   (no params)             — list ALL recent conversations for site
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url      = new URL(req.url)
  const id       = url.searchParams.get('conversationId')
  const kind     = url.searchParams.get('kind')
  const ctxId    = url.searchParams.get('id')           // page-context id (e.g. report uuid)
  const db       = createServiceClient()

  if (id) {
    const { data, error } = await db
      .from('mimir_conversations')
      .select('id, title, messages, updated_at, page_context')
      .eq('id', id)
      .eq('owner_user_id', ownerId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ conversation: data })
  }

  let q = db
    .from('mimir_conversations')
    .select('id, title, updated_at, pinned, page_context')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('updated_at', { ascending: false })
    .limit(20)

  if (kind) {
    // Filter by JSONB `kind` field via raw filter
    // PostgREST: page_context->>kind = 'monthly_report'
    q = q.eq('page_context->>kind', kind)
    if (ctxId) q = q.eq('page_context->>id', ctxId)
  }

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ conversations: data ?? [] })
}

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

// ─── Proposal parsing (only for experiments kind) ───────────────────────────
// Same regex as the legacy /api/experiments/mimir route so the experiments
// page UI can render proposal cards regardless of which endpoint generated.

const FENCE_RE = /```experiment\s*([\s\S]+?)```/g

function parseExperimentProposals(text: string): ExperimentProposal[] {
  const out: ExperimentProposal[] = []
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim())
      if (typeof obj.title === 'string' && typeof obj.hypothesis === 'string') {
        out.push({
          title:          String(obj.title).trim(),
          hypothesis:     String(obj.hypothesis).trim(),
          category:       (['on-page','content','technical','links','experimentation'].includes(obj.category) ? obj.category : 'experimentation') as ExperimentProposal['category'],
          successMetric:  String(obj.successMetric ?? '').trim(),
          baselineValue:  typeof obj.baselineValue === 'number' ? obj.baselineValue : undefined,
          targetValue:    typeof obj.targetValue   === 'number' ? obj.targetValue   : undefined,
          linkedKeywords: Array.isArray(obj.linkedKeywords) ? obj.linkedKeywords.filter((k: unknown) => typeof k === 'string') : [],
          linkedPages:    Array.isArray(obj.linkedPages)    ? obj.linkedPages.filter((k: unknown) => typeof k === 'string')    : [],
          confidence:     clampInt(obj.confidence, 1, 5) as ExperimentProposal['confidence'],
          effort:         clampInt(obj.effort, 1, 5) as ExperimentProposal['effort'],
        })
      }
    } catch { /* skip malformed */ }
  }
  return out
}

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = Number(n)
  if (Number.isNaN(v)) return lo
  return Math.max(lo, Math.min(hi, Math.round(v)))
}
