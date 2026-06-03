import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { loadKBBlock } from '@/lib/agents/brief-generator'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * POST /api/outreach/prospects/[id]/generate-opener
 *
 * Bragi writes a personalised guestpost outreach email for a prospect.
 * Two modes:
 *   - mode='opener' (default): subject + 2-4 sentence opener (legacy behavior)
 *   - mode='full':             subject + full email body with greeting,
 *                              opener, value prop, ask, and signoff
 *
 * Returns { subject, opener } for opener-mode, { subject, body } for full.
 *
 * Body (optional): { tone?: 'professional' | 'casual' | 'direct',
 *                    mode?: 'opener' | 'full' }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await params

  // ── Load prospect ────────────────────────────────────────────────────────
  const { data: prospect } = await db
    .from('outreach_prospects')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!prospect) return NextResponse.json({ error: 'Prospect not found' }, { status: 404 })

  // ── Optional body ────────────────────────────────────────────────────────
  let tone = 'professional'
  let mode: 'opener' | 'full' = 'opener'
  try {
    const body = await req.json() as { tone?: string; mode?: string }
    if (['professional', 'casual', 'direct'].includes(body.tone ?? '')) tone = body.tone!
    if (body.mode === 'full') mode = 'full'
  } catch { /* no body */ }

  // ── Build context ────────────────────────────────────────────────────────
  const prospectContext = [
    `Domain: ${prospect.domain}`,
    prospect.authority_score != null ? `Authority Score: ${prospect.authority_score}/100` : null,
    prospect.organic_traffic  != null ? `Estimated monthly organic traffic: ${Number(prospect.organic_traffic).toLocaleString()} visits` : null,
    prospect.organic_keywords != null ? `Organic keywords: ${Number(prospect.organic_keywords).toLocaleString()}` : null,
    prospect.contact_name     ? `Contact name: ${prospect.contact_name}` : null,
    prospect.topic            ? `Proposed article topic: "${prospect.topic}"` : null,
    prospect.target_url       ? `Target G2G page for the link: ${prospect.target_url}` : null,
    prospect.anchor_text      ? `Desired anchor text: "${prospect.anchor_text}"` : null,
    prospect.source_keyword   ? `Discovery keyword: "${prospect.source_keyword}"` : null,
    prospect.notes            ? `Notes: ${prospect.notes}` : null,
  ].filter(Boolean).join('\n')

  // Sprint #353 OPENER.MIMIR.INJECT — pull brand voice + category trust
  // signals from the knowledge base so the pitch reads in the SAME voice
  // as our published content. Falls back gracefully (empty string) when
  // no KB rows exist or when the prospect has no target URL to match a
  // category. Site slug priority: prospect.site_slug column > 'g2g' default.
  const siteSlug = (prospect.site_slug as string | undefined)?.toLowerCase() ?? 'g2g'
  const brandName = siteSlug === 'offgamers' ? 'OffGamers' : 'G2G'
  const brandDomain = siteSlug === 'offgamers' ? 'offgamers.com' : 'g2g.com'

  let kbBlock = ''
  try {
    kbBlock = await loadKBBlock(
      db,
      ownerId,
      prospect.target_url ?? `https://${brandDomain}/`,
      prospect.source_keyword ?? prospect.topic ?? '',
      siteSlug,
    )
  } catch (e) {
    console.warn('[generate-opener] KB load failed (continuing without):', e)
  }

  // ── Prompt ───────────────────────────────────────────────────────────────
  const sharedRules = `Rules:
- Never mention competitor names
- Avoid: "immerse yourself", "dive into", "game-changing", "revolutionize", "leverage", "delve"
- Be specific to the prospect's domain — reference what they actually cover
- Tone: ${tone}
- Pull trust signals and brand voice from the BRAND CONTEXT block below — do not invent claims that aren't supported by that block`

  // Brand-aware framing — same voice the published articles use.
  const brandIntro = siteSlug === 'offgamers'
    ? `OffGamers (offgamers.com) — a trusted digital marketplace for game keys, top-ups, gift cards, and gaming subscriptions`
    : `G2G (g2g.com) — a leading peer-to-peer gaming marketplace for in-game currency, items, game accounts, and top-ups`

  const systemPrompt = mode === 'full'
    ? `You are Bragi, ${brandName}'s content and outreach copywriter. You write personalised, ${tone} full guestpost outreach EMAILS on behalf of ${brandIntro}.
${kbBlock ? `\n${kbBlock}\n` : ''}
${sharedRules}

For FULL EMAIL mode, the body should follow this structure:
  1. Greeting line (e.g. "Hi [Name]," or "Hi there,")
  2. Personalized opener referencing the prospect's site (1-2 sentences)
  3. Value proposition: what content we'd contribute + why it fits THEIR audience (2-3 sentences)
  4. Light credibility plug — 1 trust signal pulled from BRAND CONTEXT (NOT a brag dump)
  5. Clear, low-pressure ask
  6. Signoff (e.g. "Best, ${brandName} outreach team")

Total length: 120-180 words. Subject: ≤ 10 words.`
    : `You are Bragi, ${brandName}'s content and outreach copywriter. You write personalised, ${tone} guestpost outreach emails on behalf of ${brandIntro}.
${kbBlock ? `\n${kbBlock}\n` : ''}
${sharedRules}
- Keep it short: subject ≤ 10 words, opener ≤ 4 sentences
- Opener should NOT include a salutation line (like "Hi [Name]") — just the body paragraph
- End with a clear, low-pressure ask (e.g. "Would you be open to a quick chat about a collaboration?")`

  const userPrompt = mode === 'full'
    ? `Write a complete guestpost outreach email for this prospect:

${prospectContext}

Return ONLY a JSON object with exactly two fields:
{
  "subject": "the email subject line",
  "body":    "the full email body (greeting + opener + value prop + ask + signoff)"
}`
    : `Write a guestpost outreach email opener for this prospect:

${prospectContext}

Return ONLY a JSON object with exactly two fields:
{
  "subject": "the email subject line",
  "opener": "the email body opener paragraph (no salutation, just the content)"
}`

  // ── Call Claude ──────────────────────────────────────────────────────────
  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: mode === 'full' ? 900 : 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''

    // Extract JSON — Claude may wrap in ```json ... ```
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; opener?: string; body?: string }
    if (!parsed.subject) throw new Error('Invalid response shape — missing subject')
    if (mode === 'full' && !parsed.body)   throw new Error('Invalid response shape — missing body')
    if (mode === 'opener' && !parsed.opener) throw new Error('Invalid response shape — missing opener')

    return NextResponse.json({
      ok:      true,
      mode,
      subject: parsed.subject.trim(),
      opener:  mode === 'opener' ? parsed.opener?.trim() : undefined,
      body:    mode === 'full'   ? parsed.body?.trim()   : undefined,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generation failed'
    console.error('[generate-opener]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
