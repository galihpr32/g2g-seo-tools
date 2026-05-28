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
  // Sprint PP.GSC.REFRESH+ — also use product.url to compute page-level totals
  // (all queries hitting the page, tracked + untracked), surfaced as a
  // diagnostic header in the leaderboard so user sees the gap between
  // "what I track" and "what page actually ranks for".
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

  // ── 5b. Page-level totals + top untracked queries for THIS product URL ────
  // Sprint PP.GSC.REFRESH+ — surfaces the "detail page card vs dashboard"
  // discrepancy: detail page shows 2.8K clicks because it aggregates ALL
  // queries to /categories/aion-2-kinah, while keyword-only mode only counts
  // exact tier_keyword matches (often 0 because real searches are variants).
  //
  // We compute the latest-snapshot rollup for THIS product page, regardless
  // of whether the query is tracked. Returns header diagnostic + top 5
  // untracked queries so user knows what to claim.
  type PageQueryAgg = { impressions: number; clicks: number; posWeighted: number }
  const pageQueryAgg = new Map<string, PageQueryAgg>()   // query → totals at latest snapshot
  let pageLatestDate: string | null = null
  if (product.url) {
    function pathOfLocal(u: string): string {
      try { return new URL(u).pathname.replace(/\/+$/, '') }
      catch { return u.replace(/\/+$/, '') }
    }
    const productPath = pathOfLocal(product.url)
    // Find the latest snapshot_date that has any row matching this page
    const datesWithPage = new Set<string>()
    for (const r of snaps) {
      const rp = pathOfLocal(r.page)
      if (rp === productPath || rp.startsWith(productPath + '/') || rp.startsWith(productPath + '?')) {
        datesWithPage.add(r.snapshot_date)
      }
    }
    pageLatestDate = Array.from(datesWithPage).sort().reverse()[0] ?? null
    if (pageLatestDate) {
      for (const r of snaps) {
        if (r.snapshot_date !== pageLatestDate) continue
        const rp = pathOfLocal(r.page)
        if (rp !== productPath && !rp.startsWith(productPath + '/') && !rp.startsWith(productPath + '?')) continue
        const q = String(r.query ?? '').toLowerCase().trim()
        if (!q) continue
        const cell = pageQueryAgg.get(q) ?? { impressions: 0, clicks: 0, posWeighted: 0 }
        cell.impressions += r.impressions
        cell.clicks      += r.clicks
        cell.posWeighted += r.position * r.impressions
        pageQueryAgg.set(q, cell)
      }
    }
  }

  let pageTotalImpressions = 0
  let pageTotalClicks      = 0
  for (const cell of pageQueryAgg.values()) {
    pageTotalImpressions += cell.impressions
    pageTotalClicks      += cell.clicks
  }
  const topUntrackedQueries = Array.from(pageQueryAgg.entries())
    .filter(([q]) => !kwLower.has(q))
    .map(([q, cell]) => ({
      query:       q,
      impressions: cell.impressions,
      clicks:      cell.clicks,
      avgPosition: cell.impressions > 0 ? +(cell.posWeighted / cell.impressions).toFixed(2) : null,
    }))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10)
  const untrackedCount = Array.from(pageQueryAgg.keys()).filter(q => !kwLower.has(q)).length

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
    // Sprint PP.GSC.REFRESH+ — page-level summary so user sees gap between
    // "what tracked kws produced" vs "what the product page actually got"
    pageTotals: {
      impressions:         pageTotalImpressions,
      clicks:              pageTotalClicks,
      distinctQueries:     pageQueryAgg.size,
      untrackedCount,
      latestDate:          pageLatestDate,
    },
    topUntrackedQueries,
  })
}
