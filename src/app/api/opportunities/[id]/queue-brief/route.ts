import { NextResponse }          from 'next/server'
import { createClient }          from '@/lib/supabase/server'
import { createServiceClient }   from '@/lib/supabase/service'
import { getEffectiveOwnerId }   from '@/lib/workspace'
import { generateAgentBrief }    from '@/lib/agents/brief-generator'
import { getSiteUrlForSlug, buildCategoryUrl, normalizeUrl } from '@/lib/agents/site-helpers'

/**
 * POST /api/opportunities/[id]/queue-brief
 *
 * Creates a brief directly from an seo_opportunities row — bypassing the
 * normal Bragi → approval queue path because the human already made their
 * decision at the Opportunity triage step.
 *
 * Flow:
 *  1. Load opportunity + its signals
 *  2. Derive primary keyword + page URL from signals (Loki > Odin > Heimdall)
 *  3. Insert seo_content_briefs row (status: 'draft')
 *  4. Fire generateAgentBrief in the background (don't block response)
 *  5. Link brief_id back to the opportunity; set opportunity status → 'brief_queued'
 *
 * Returns: { briefId, keyword, pageUrl }
 */

interface SignalEntry {
  action_id:      string
  agent_key:      string
  keyword?:       string
  search_volume?: number
  page?:          string
  clicks_drop?:   number
  clicks_drop_pct?: number
  game_name?:     string
  competitor_domain?: string
  [key: string]: unknown
}

interface Opportunity {
  id:               string
  owner_user_id:    string
  site_slug:        string
  topic:            string
  topic_slug:       string
  target_url:       string | null
  output_type:      string | null
  status:           string
  heimdall_signals: SignalEntry[]
  loki_signals:     SignalEntry[]
  odin_signals:     SignalEntry[]
  total_sv:         number
}

// ── Keyword selection ────────────────────────────────────────────────────────

/**
 * Pick the best primary keyword from the opportunity's signals.
 *
 * Priority:
 *  1. Loki (highest SV keyword gap — most actionable for SEO)
 *  2. Odin (trending game — search demand confirmed)
 *  3. Topic slug as fallback
 */
function pickPrimaryKeyword(opp: Opportunity): string {
  // Loki: highest search_volume
  if (opp.loki_signals?.length) {
    const best = [...opp.loki_signals].sort(
      (a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0)
    )[0]
    if (best.keyword) return String(best.keyword)
  }

  // Odin: game name
  if (opp.odin_signals?.length) {
    const best = [...opp.odin_signals].sort(
      (a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0)
    )[0]
    if (best.game_name) return String(best.game_name)
  }

  // Fallback: humanise the topic slug
  return opp.topic
}

/**
 * Determine page URL.
 *  - optimize_existing + Heimdall signal → use the actual page being tracked
 *  - Otherwise → build category URL from primary keyword
 */
function pickPageUrl(opp: Opportunity, siteUrl: string, keyword: string): string {
  if (opp.output_type === 'optimize_existing' && opp.target_url) {
    return opp.target_url
  }
  if (opp.heimdall_signals?.length && opp.target_url) {
    return opp.target_url   // always prefer a concrete existing page
  }
  return buildCategoryUrl(siteUrl, keyword)
}

/**
 * Determine brief_type from output_type.
 */
function pickBriefType(opp: Opportunity): string {
  if (opp.output_type === 'optimize_existing') return 'on_page'
  if (opp.output_type === 'outreach')          return 'outreach'
  return 'category_page'
}

/**
 * Build a rich context string for the brief-generator prompt.
 * Gives Claude the signal provenance so it can write more targeted copy.
 */
function buildContext(opp: Opportunity): string {
  const lines: string[] = [`Opportunity: "${opp.topic}"`]

  if (opp.heimdall_signals?.length) {
    const drops = opp.heimdall_signals
      .map(s => `${s.page ? String(s.page).replace(/^https?:\/\/[^/]+/, '') : '?'} (${s.clicks_drop_pct ? `-${Number(s.clicks_drop_pct).toFixed(0)}%` : 'drop'})`)
      .slice(0, 3).join(', ')
    lines.push(`Heimdall detected ranking drops on: ${drops}`)
  }

  if (opp.loki_signals?.length) {
    const gaps = opp.loki_signals
      .sort((a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0))
      .slice(0, 5)
      .map(s => `"${s.keyword}" (${Number(s.search_volume || 0).toLocaleString()} SV${s.competitor_domain ? `, ${s.competitor_domain} ranks` : ''})`)
      .join('; ')
    lines.push(`Loki keyword gaps: ${gaps}`)
  }

  if (opp.odin_signals?.length) {
    const trends = opp.odin_signals
      .slice(0, 3)
      .map(s => `${s.game_name} (${Number(s.search_volume || 0).toLocaleString()} SV)`)
      .join(', ')
    lines.push(`Odin trending: ${trends}`)
  }

  lines.push(`Output type: ${opp.output_type ?? 'new_page'}. Prioritise commercial intent and gaming marketplace context.`)
  return lines.join('\n')
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id: oppId } = await params

  // ── 1. Load opportunity ──────────────────────────────────────────────────
  const { data: opp, error: oppErr } = await db
    .from('seo_opportunities')
    .select(`
      id, owner_user_id, site_slug, topic, topic_slug, target_url,
      output_type, status, total_sv,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('id', oppId)
    .eq('owner_user_id', effectiveOwnerId)
    .single()

  if (oppErr || !opp) {
    return NextResponse.json({ error: 'Opportunity not found' }, { status: 404 })
  }

  const opportunity = opp as unknown as Opportunity

  // Guard: already has a brief in flight?
  if (opportunity.status === 'brief_queued' || opportunity.status === 'brief_ready') {
    return NextResponse.json({ error: 'Brief already queued for this opportunity' }, { status: 409 })
  }

  // ── 2. Resolve site ──────────────────────────────────────────────────────
  const site = await getSiteUrlForSlug(db, opportunity.site_slug ?? 'g2g')

  // ── 3. Derive keyword + page ─────────────────────────────────────────────
  const keyword  = pickPrimaryKeyword(opportunity)
  const pageUrl  = pickPageUrl(opportunity, site.siteUrl, keyword)
  const briefType = pickBriefType(opportunity)
  const context  = buildContext(opportunity)
  const searchVolume = opportunity.total_sv || undefined

  // Top competitor URL from Loki if available
  const competitorUrl = (() => {
    if (!opportunity.loki_signals?.length) return null
    const best = [...opportunity.loki_signals].sort(
      (a, b) => (Number(b.search_volume) || 0) - (Number(a.search_volume) || 0)
    )[0]
    return best.competitor_domain ? `https://${best.competitor_domain}` : null
  })()

  // Guard: duplicate brief for same page?
  const pageNorm = normalizeUrl(pageUrl)
  const { data: existingBriefs } = await db
    .from('seo_content_briefs')
    .select('id, page')
    .eq('owner_user_id', effectiveOwnerId)

  const dupBrief = (existingBriefs ?? []).find(b => normalizeUrl(String(b.page)) === pageNorm)
  if (dupBrief) {
    // Link and return the existing brief rather than creating a duplicate
    await db
      .from('seo_opportunities')
      .update({ brief_id: dupBrief.id, status: 'brief_ready', updated_at: new Date().toISOString() })
      .eq('id', oppId)
    return NextResponse.json({ briefId: dupBrief.id, keyword, pageUrl, existing: true })
  }

  // ── 4. Create the brief row ──────────────────────────────────────────────
  const { data: newBrief, error: insertErr } = await db
    .from('seo_content_briefs')
    .insert({
      owner_user_id:   effectiveOwnerId,
      site_url:        site.siteUrl,
      page:            pageUrl,
      brief_type:      briefType,
      primary_keyword: keyword,
      status:          'draft',
      notes: [
        context,
        competitorUrl ? `Top competitor reference: ${competitorUrl}` : null,
        `Queued from Opportunity: "${opportunity.topic}" (${oppId})`,
      ].filter(Boolean).join('\n'),
    })
    .select('id')
    .single()

  if (insertErr || !newBrief) {
    return NextResponse.json({ error: insertErr?.message ?? 'Brief insert failed' }, { status: 500 })
  }

  const briefId = newBrief.id

  // ── 5. Link brief_id to opportunity immediately ──────────────────────────
  await db
    .from('seo_opportunities')
    .update({
      brief_id:   briefId,
      status:     'brief_queued',
      updated_at: new Date().toISOString(),
    })
    .eq('id', oppId)

  // ── 6. Generate brief in the background (don't await — returns fast) ─────
  // generateAgentBrief handles its own retries + sets brief status to
  // 'agent_generated' on success or reverts to 'draft' on failure.
  generateAgentBrief({
    briefId,
    ownerId:       effectiveOwnerId,
    keyword,
    pageUrl,
    briefType,
    searchVolume,
    competitorUrl,
    notes:         context,
  }).then(() => {
    // On generation success → promote opportunity to brief_ready
    db.from('seo_opportunities')
      .update({ status: 'brief_ready', updated_at: new Date().toISOString() })
      .eq('id', oppId)
      .then(() => {})
  }).catch(err => {
    console.error('[queue-brief] generateAgentBrief failed:', err)
    // Brief stays in 'draft' — user can open it manually
  })

  return NextResponse.json({ briefId, keyword, pageUrl })
}
