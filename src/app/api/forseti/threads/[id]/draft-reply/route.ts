// Sprint #354 FORSETI.AI.REPLY — draft a Reddit reply for a Forseti thread
// using Mimir brand context + Anthropic. The human reviews/edits before
// actually posting on Reddit (we never auto-post — Reddit ToS + brand
// safety).
//
// POST /api/forseti/threads/[id]/draft-reply
//   Optional body: { tone?: 'helpful' | 'empathetic' | 'professional' }
//
// Returns: { ok, draft, context_summary, model }
//
// Frontend pre-fills the response textarea with `draft`. User edits +
// posts to Reddit manually + then pastes the comment URL back into the
// archive form.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { loadKBBlock } from '@/lib/agents/brief-generator'
import Anthropic from '@anthropic-ai/sdk'

export const runtime     = 'nodejs'
export const maxDuration = 45
export const dynamic     = 'force-dynamic'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.FORSETI_REPLY_MODEL ?? 'claude-sonnet-4-6'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await params

  // Tone override
  let tone: 'helpful' | 'empathetic' | 'professional' = 'helpful'
  try {
    const body = await req.json() as { tone?: string }
    if (['helpful', 'empathetic', 'professional'].includes(body.tone ?? '')) {
      tone = body.tone as typeof tone
    }
  } catch {/* no body */}

  // ── Load thread + subreddit config ────────────────────────────────────
  const { data: thread, error: tErr } = await db
    .from('forseti_threads')
    .select(`
      id, subreddit, thread_title, op_username, op_post_body,
      auto_category, manual_category_override, effective_category,
      auto_severity, manual_severity_override, effective_severity,
      site_slug, reddit_url
    `)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (tErr)   return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const siteSlug    = (thread.site_slug as string | undefined)?.toLowerCase() ?? 'g2g'
  const brandName   = siteSlug === 'offgamers' ? 'OffGamers' : 'G2G'
  const brandDomain = siteSlug === 'offgamers' ? 'offgamers.com' : 'g2g.com'

  // ── Load Mimir brand + category context ───────────────────────────────
  let kbBlock = ''
  try {
    kbBlock = await loadKBBlock(
      db,
      ownerId,
      `https://${brandDomain}/`,
      // category gives us topical context (e.g. "delivery", "scam", "support")
      thread.effective_category ?? thread.thread_title ?? '',
      siteSlug,
    )
  } catch (e) {
    console.warn('[forseti draft-reply] KB load failed (continuing without):', e)
  }

  // ── Build prompt ──────────────────────────────────────────────────────
  // Severity 4-5 = urgent / brand-safety. Different tone guidance.
  const isHighSeverity = (thread.effective_severity ?? 1) >= 4
  const categoryHint   = thread.effective_category ?? 'general'

  const systemPrompt = `You are the official ${brandName} representative on Reddit, drafting a community reply for r/${thread.subreddit}. ${brandName} (${brandDomain}) is a trusted gaming marketplace.
${kbBlock ? `\n${kbBlock}\n` : ''}
Reply rules (Reddit-native voice — NOT a corporate response):
- Length: 2-4 short paragraphs, max 150 words. Reddit downvotes wall-of-text corporate replies.
- Tone: ${tone}. ${isHighSeverity ? 'This is a high-severity post (potential brand damage). Lead with empathy + acknowledge the concern before any defense.' : 'Helpful, peer-to-peer voice — like a knowledgeable community member who happens to work for the brand.'}
- Open with acknowledgment of the user's question/concern (1 sentence).
- Provide a direct, useful answer or guidance.
- Mention ${brandName} naturally ONCE — never spam the brand. The link to ${brandDomain} can appear if relevant, but DO NOT force it.
- Cite specific trust signals from the BRAND CONTEXT above when they directly address the concern. Don't dump generic marketing language.
- End with an offer to help further OR an invitation to DM if it's account-specific.
- Sign off as "— ${brandName} Team" or similar low-key marker. Reddit users hate disguised corporate replies.
- NEVER: deny problems that exist, promise fixes you can't deliver, mention competitor names, use marketing buzzwords ("revolutionize", "leverage", "best-in-class", "immerse").
- Markdown formatting allowed (* for italics, ** for bold, > for quotes, line breaks) — Reddit supports it.

Category context: this post is classified as "${categoryHint}" by our triage system. Tailor your reply to that intent (e.g. "delivery" = focus on speed/tracking; "scam_accusation" = focus on protection mechanisms; "general_question" = direct helpful answer).`

  const userPrompt = `Reddit thread to reply to:

SUBREDDIT: r/${thread.subreddit}
TITLE: ${thread.thread_title}
${thread.op_username ? `POSTED BY: u/${thread.op_username}` : ''}
SEVERITY: ${thread.effective_severity}/5 (${isHighSeverity ? 'high — brand safety concern' : 'normal'})
CATEGORY: ${categoryHint}

ORIGINAL POST BODY:
${thread.op_post_body?.trim() || '(no body text — likely a link post or title-only post. Reply based on the title alone.)'}

REDDIT URL (for your reference): ${thread.reddit_url}

Write the reply. Return ONLY the reply text — plain Reddit-flavoured markdown, no preamble, no JSON, no explanation. Start directly with the first sentence.`

  // ── Call Claude ───────────────────────────────────────────────────────
  try {
    const response = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const draft = response.content
      .filter(b => b.type === 'text')
      .map(b => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim()

    if (!draft || draft.length < 40) {
      return NextResponse.json({
        ok:    false,
        error: `Draft too short (${draft.length} chars) — model may have refused. Try regenerating or change tone.`,
      }, { status: 500 })
    }

    return NextResponse.json({
      ok:    true,
      model: MODEL,
      tone,
      severity: thread.effective_severity,
      category: categoryHint,
      draft,
      // Diagnostic for the UI
      context_summary: kbBlock
        ? `Used KB brand context (${kbBlock.length} chars) + thread metadata`
        : 'No KB rows matched — used thread metadata only',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generation failed'
    console.error('[forseti draft-reply]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
