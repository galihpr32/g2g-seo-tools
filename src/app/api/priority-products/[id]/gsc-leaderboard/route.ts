import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
// stripLocale used to live here pre-Sprint PP.GSC.KEYWORD.ANCHOR. URL match
// dropped, so locale stripping is no longer needed in this endpoint.

export const maxDuration = 30

/**
 * GET /api/priority-products/[id]/gsc-leaderboard
 *
 * Sprint PP.GSC.MATCH.HINT — when Rankings Dashboard is in GSC mode, the
 * inline expanded leaderboard should show GSC numbers (impressions, clicks,
 * impression-weighted avg position) per tier_keyword instead of DFS positions.
 *
 * Algorithm mirrors fetchRankingsGSC (snapshot-based, keyword-anchored):
 *   1. Load tier_keywords for this product
 *   2. Resolve site_url from site_configs
 *   3. Pull gsc_query_snapshots for last 120d where query matches one of the
 *      tier_keywords (URL filter dropped in Sprint PP.GSC.KEYWORD.ANCHOR —
 *      aggregate impressions across all pages site-wide)
 *   4. For each kw: latest snapshot = current, snapshot ~28d before latest = prior
 *   5. Also track per-page breakdown so user sees which URL Google ranks
 *
 * Returns:
 *   leaderboard: [{ keyword, is_main, has_signal, impressions, clicks, ctr,
 *                  avgPosition, priorPosition, deltaPosition, latestDate }]
 *   matched / total
 */
const GSC_WOW_DAYS  = 28

function addDays(d: Date, n: number): Date {
  const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x
}
function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }

export async function GET(
  req:  Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  // 1. Product info
  const { data: product, error: prodErr } = await db
    .from('product_tiers')
    .select('id, url, product_name')
    .eq('id', productId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (prodErr || !product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 })
  }

  // 2. Tier keywords for this product
  const { data: kwRows } = await db
    .from('tier_keywords')
    .select('id, keyword, language, is_main')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .order('is_main', { ascending: false })
    .order('position', { ascending: true })
  const kws = (kwRows ?? []) as Array<{ id: string; keyword: string; language: string | null; is_main: boolean }>
  const kwLower = new Set(kws.map(k => k.keyword.toLowerCase().trim()))

  // 3. GSC property URL
  const { data: siteCfg } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .maybeSingle()
  const gscPropertyUrl = (siteCfg?.gsc_property as string | undefined) ?? null
  if (!gscPropertyUrl) {
    return NextResponse.json({
      leaderboard: kws.map(k => ({
        keyword: k.keyword, language: k.language, is_main: k.is_main,
        has_signal: false, impressions: 0, clicks: 0, ctr: 0,
        avgPosition: null, priorPosition: null, deltaPosition: null, latestDate: null,
      })),
      matched: 0,
      total: kws.length,
      error: 'No GSC property configured for this site',
    })
  }

  // 4. Pull snapshots for the past 120d
  // Sprint PP.GSC.KEYWORD.ANCHOR — product.url is no longer required since we
  // match by keyword across all pages. URL only used as an optional fallback
  // hint elsewhere; if missing, that's fine.
  const now = new Date()
  const fetchSince = isoDate(addDays(now, -120))

  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', fetchSince)
    .order('snapshot_date', { ascending: false })
    .limit(20_000)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const snaps = (snapsRaw ?? []) as Array<{
    snapshot_date: string; page: string; query: string
    clicks: number; impressions: number; position: number
  }>

  // 5. Sprint PP.GSC.KEYWORD.ANCHOR — drop URL filter. Match purely by keyword.
  // Aggregate impressions across ALL pages on the site (categories + offer
  // pages + locale variants etc). Also track which page got the most impressions
  // per kw so we can surface it as a "Top page" diagnostic column.
  type Cell = { impressions: number; clicks: number; posWeighted: number }
  const observations = new Map<string, Array<{ date: string; cell: Cell }>>()  // key: kw
  // pageBreakdown[kw] = Map<page, { impressions, clicks }>
  const pageBreakdown = new Map<string, Map<string, { impressions: number; clicks: number }>>()

  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q || !kwLower.has(q)) continue

    // Aggregate by snapshot_date for current/prior calc
    let list = observations.get(q)
    if (!list) { list = []; observations.set(q, list) }
    let entry = list.find(e => e.date === r.snapshot_date)
    if (!entry) {
      entry = { date: r.snapshot_date, cell: { impressions: 0, clicks: 0, posWeighted: 0 } }
      list.push(entry)
    }
    entry.cell.impressions += r.impressions
    entry.cell.clicks      += r.clicks
    entry.cell.posWeighted += r.position * r.impressions

    // Track per-page totals so user can see "which URL Google actually ranks"
    let pages = pageBreakdown.get(q)
    if (!pages) { pages = new Map(); pageBreakdown.set(q, pages) }
    const cur = pages.get(r.page) ?? { impressions: 0, clicks: 0 }
    cur.impressions += r.impressions
    cur.clicks      += r.clicks
    pages.set(r.page, cur)
  }
  for (const list of observations.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date))
  }

  // 7. For each tier keyword, build a leaderboard row
  let matched = 0
  const leaderboard = kws.map(k => {
    const q = k.keyword.toLowerCase().trim()
    const list = observations.get(q) ?? []
    const latest = list[0]
    if (latest && latest.cell.impressions > 0) matched++

    // Find prior snapshot ~28d before latest (closest within ±5d)
    type Observation = { date: string; cell: Cell }
    let prior: Observation | null = null
    if (latest) {
      const targetMs = new Date(latest.date).getTime() - GSC_WOW_DAYS * 86_400_000
      let best: Observation | null = null
      let bestDiff = Infinity
      for (const entry of list) {
        if (entry.date >= latest.date) continue
        const diff = Math.abs(new Date(entry.date).getTime() - targetMs)
        if (diff < bestDiff) { bestDiff = diff; best = entry }
      }
      prior = best
    }

    const curPos   = latest && latest.cell.impressions > 0
      ? +(latest.cell.posWeighted / latest.cell.impressions).toFixed(2)
      : null
    const priorPos = prior  && prior.cell.impressions  > 0
      ? +(prior.cell.posWeighted  / prior.cell.impressions).toFixed(2)
      : null
    const deltaPos = (curPos != null && priorPos != null)
      ? +(priorPos - curPos).toFixed(2)   // positive = improved
      : null

    const impressions = latest?.cell.impressions ?? 0
    const clicks      = latest?.cell.clicks      ?? 0
    const ctr         = impressions > 0 ? +((clicks / impressions) * 100).toFixed(2) : 0

    // Sprint PP.GSC.KEYWORD.ANCHOR — surface which page got the most
    // impressions for this kw. Lets user see if their tier product.url is
    // actually the ranking URL or if Google prefers an offer/sibling page.
    const pages = pageBreakdown.get(q) ?? new Map<string, { impressions: number; clicks: number }>()
    let topPage: { page: string; impressions: number; clicks: number } | null = null
    for (const [page, tot] of pages) {
      if (!topPage || tot.impressions > topPage.impressions) {
        topPage = { page, impressions: tot.impressions, clicks: tot.clicks }
      }
    }
    const distinctPages = pages.size

    return {
      keyword:       k.keyword,
      language:      k.language,
      is_main:       k.is_main,
      has_signal:    impressions > 0,
      impressions,
      clicks,
      ctr,
      avgPosition:   curPos,
      priorPosition: priorPos,
      deltaPosition: deltaPos,
      latestDate:    latest?.date ?? null,
      topPage:       topPage?.page ?? null,
      topPageShare:  (impressions > 0 && topPage) ? +((topPage.impressions / impressions) * 100).toFixed(0) : null,
      distinctPages,
    }
  })

  return NextResponse.json({
    leaderboard,
    matched,
    total: kws.length,
    productName: product.product_name,
    productUrl:  product.url ?? null,
  })
}
