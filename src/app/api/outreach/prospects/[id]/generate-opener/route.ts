import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * POST /api/outreach/prospects/[id]/generate-opener
 *
 * Bragi writes a personalised guestpost outreach email opener for a
 * prospect. Returns { subject, opener } — both ~2–4 sentences, ready
 * to paste into an email client.
 *
 * Body (optional): { tone?: 'professional' | 'casual' | 'direct' }
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
  try {
    const body = await req.json() as { tone?: string }
    if (['professional', 'casual', 'direct'].includes(body.tone ?? '')) tone = body.tone!
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

  // ── Prompt ───────────────────────────────────────────────────────────────
  const systemPrompt = `You are Bragi, G2G's content and outreach copywriter. You write personalised, ${tone} guestpost outreach emails on behalf of G2G (g2g.com) — a leading peer-to-peer gaming marketplace for in-game currency, items, game accounts, and top-ups.

G2G's key trust signals: GamerProtect buyer protection, escrow system, 200+ payment methods, verified sellers, ISO/IEC 27001:2013 certified, 5M+ transactions.

Rules:
- Never mention competitor names
- Avoid: "immerse yourself", "dive into", "game-changing", "revolutionize", "leverage", "delve"
- Be specific to the prospect's domain — reference what they actually cover
- Keep it short: subject ≤ 10 words, opener ≤ 4 sentences
- Opener should NOT include a salutation line (like "Hi [Name]") — just the body paragraph
- End with a clear, low-pressure ask (e.g. "Would you be open to a quick chat about a collaboration?")
- Tone: ${tone}`

  const userPrompt = `Write a guestpost outreach email opener for this prospect:

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
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : ''

    // Extract JSON — Claude may wrap in ```json ... ```
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON in response')

    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; opener?: string }
    if (!parsed.subject || !parsed.opener) throw new Error('Invalid response shape')

    return NextResponse.json({
      ok:      true,
      subject: parsed.subject.trim(),
      opener:  parsed.opener.trim(),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Generation failed'
    console.error('[generate-opener]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
