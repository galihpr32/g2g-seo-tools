// ── Priority Products data source switcher ──────────────────────────────────
//
// Sprint PP.GSC.TOGGLE.1 — abstracts the rankings data layer so the page can
// flip between three sources:
//
//   • dfs            — DataForSEO weekly SERP scrape (current default)
//   • gsc            — Google Search Console queries (impression-weighted)
//   • gsc-discovery  — top GSC queries per product URL, regardless of
//                      whether the keyword is curated in tier_keywords.
//                      Surfaces winners we never thought to track.
//
// Decisions locked with Galih:
//   • Window: 7d rolling with GSC lag=4d (so today's window = [today-11d, today-4d])
//   • WoW comparison: 28d vs prior 28d (smoother, less noise)
//   • Top 3 boundary: position ≤ 3.5
//
// The endpoint /api/priority-products/rankings dispatches to one of these
// builders. They all return the same shape so the page UI stays simple.
//
// Important: gsc_query_snapshots is keyed by site_url, NOT owner_user_id.
// Lookup chain: site_slug → site_configs.gsc_property → snapshots.

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Constants ─────────────────────────────────────────────────────────────

const GSC_LAG_DAYS         = 4    // GSC has a 3-4 day data lag
const GSC_WINDOW_DAYS      = 7    // 7d rolling window
const GSC_WOW_COMPARE_DAYS = 28   // 28d vs prior 28d for delta signals
const TOP_3_BOUNDARY       = 3.5

// ─── Shared types (mirror existing /api/priority-products/rankings shape) ───

export interface Kpis {
  kwTracked:        number
  avgPosition:      number | null
  avgPositionDelta: number | null   // positive = improved (lower number is better)
  top3:             number
  top3Delta:        number
  top10:            number
  top10Delta:       number
  top20:            number
  notRanking:       number
  notRankingDelta:  number
  // GSC-specific extras (null in DFS mode)
  totalImpressions:    number | null
  totalImpressionsDelta: number | null
  totalClicks:         number | null
  totalClicksDelta:    number | null
}

export interface DistributionPoint {
  date:    string   // YYYY-MM-DD (the end-of-window date)
  top3:    number
  top10:   number
  top20:   number
  top50:   number
  outside: number
}

export interface Mover {
  productName: string
  keyword:     string
  market:      string
  prevPos:     number | null
  currPos:     number | null
  delta:       number
}

export interface ProductSummary {
  id:               string
  productName:      string
  tier:             1 | 2
  category:         string | null
  url:              string | null
  restriction_type: string | null
  market:           'us' | 'id'
  kwCount:          number
  avgPosition:      number | null
  top3:             number
  top10:            number
  wowDelta:         number | null
  // GSC-only extras
  impressions:      number | null
  clicks:           number | null
}

export interface CompetitorRow {
  domain:        string
  kwOutranking:  number
  avgPos:        number
}

export type DataSource = 'dfs' | 'gsc' | 'gsc-discovery'

export interface RankingsBundle {
  source:        DataSource
  filters:       Record<string, string>
  kpis:          Kpis
  distribution:  DistributionPoint[]
  topMovers:     { gainers: Mover[]; losers: Mover[] }
  products:      ProductSummary[]
  competitors:   CompetitorRow[]
  categories:    string[]
  markets:       readonly string[]
  // Diagnostic — only meaningful in GSC modes. Tells the page when data is
  // sparse so it can render an empty-state hint instead of misleading zeros.
  meta:          {
    windowStart: string | null
    windowEnd:   string | null
    priorStart:  string | null
    priorEnd:    string | null
    snapshotsScanned: number
    queriesMatched:   number
  }
}

// ─── Date helpers ──────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + days)
  return x
}

/**
 * Returns the canonical [windowEnd, windowStart, priorEnd, priorStart] date
 * tuple for GSC mode given the current date. Anchored at "today - lag" so we
 * never query an empty future window.
 *
 *   windowEnd   = today - lag
 *   windowStart = windowEnd - (window - 1)
 *   priorEnd    = windowStart - 1
 *   priorStart  = priorEnd - (window - 1)
 *
 * Same shape used for both the 7d-rolling fetch (impressions/clicks/avg pos
 * snapshot) and the 28d WoW comparison (different window value passed in).
 */
function windowRange(now: Date, window: number, lag: number): {
  windowStart: string
  windowEnd:   string
  priorStart:  string
  priorEnd:    string
} {
  const wEnd   = addDays(now, -lag)
  const wStart = addDays(wEnd, -(window - 1))
  const pEnd   = addDays(wStart, -1)
  const pStart = addDays(pEnd, -(window - 1))
  return { windowStart: isoDate(wStart), windowEnd: isoDate(wEnd), priorStart: isoDate(pStart), priorEnd: isoDate(pEnd) }
}

// ─── Input shapes (resolved upstream) ──────────────────────────────────────

export interface FetchOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>
  ownerId:   string
  siteSlug:  string
  /** GSC property URL — needed for GSC modes. DFS mode ignores this. */
  gscPropertyUrl: string | null
  /** Pre-filtered product set (already had tier/market/category filters applied). */
  products:  Array<{
    id:               string
    tier:             1 | 2
    product_name:     string
    category:         string | null
    url:              string | null
    relation_id:      string | null
    restriction_type: string | null
    market:           'us' | 'id'
  }>
  /** Filter inputs (used for the response.filters echo). */
  filters:   Record<string, string>
  /** Range param ('1w', '4w', '8w', '12w') — DFS uses this for chart depth.
   *  GSC ignores it; we always show 8w. */
  range:     string
  /** Pre-computed `categories` list for the filter dropdown. */
  categories: string[]
  /** Markets list to echo in response (UI uses for filter chips). */
  markets:    readonly string[]
}

// ─── GSC builder ───────────────────────────────────────────────────────────

/**
 * Build the rankings bundle from Google Search Console snapshot data.
 *
 * Matching strategy: for each product we know its `url` (page URL). We find
 * GSC rows whose `page` starts with `product.url` and whose `query` matches
 * a kw in tier_keywords for that product. Aggregating impressions/clicks
 * across the 7d window, and computing impression-weighted average position.
 *
 * For the 8-week distribution chart, we bucket each calendar week ending on
 * a Sunday across the past 8 weeks.
 *
 * Strict reduction: rows with 0 impressions in the window are EXCLUDED
 * (GSC reports 0-impression rows sometimes, those tell us nothing).
 */
export async function fetchRankingsGSC(opts: FetchOpts): Promise<RankingsBundle> {
  const { db, ownerId, products, filters, categories, markets, gscPropertyUrl } = opts

  if (!gscPropertyUrl) {
    return emptyBundle('gsc', filters, categories, markets, 'No GSC property configured for this site')
  }
  if (products.length === 0) {
    return emptyBundle('gsc', filters, categories, markets)
  }

  // ── Load tier_keywords for these products (kw set we want to track) ───────
  const productIds = products.map(p => p.id)
  const { data: kwRows } = await db
    .from('tier_keywords')
    .select('id, product_tier_id, keyword')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)

  const kwByProduct = new Map<string, Set<string>>()
  for (const r of (kwRows ?? [])) {
    const set = kwByProduct.get(r.product_tier_id as string) ?? new Set<string>()
    set.add(String(r.keyword).toLowerCase().trim())
    kwByProduct.set(r.product_tier_id as string, set)
  }
  const allKwLower = new Set<string>()
  for (const set of kwByProduct.values()) for (const k of set) allKwLower.add(k)

  // ── Date windows ───────────────────────────────────────────────────────────
  const now = new Date()
  const w7  = windowRange(now, GSC_WINDOW_DAYS,      GSC_LAG_DAYS)
  const w28 = windowRange(now, GSC_WOW_COMPARE_DAYS, GSC_LAG_DAYS)
  // For chart: 8 weeks of weekly buckets, anchored on most recent window end.
  const chartStart = isoDate(addDays(addDays(now, -GSC_LAG_DAYS), -8 * 7))

  // ── Fetch GSC snapshots for the full chart range (covers w7 + w28 + history) ──
  // We over-fetch slightly (8 weeks) and bucket in memory. This is cheaper
  // than firing 3 separate queries against the same date range.
  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', chartStart)
    .lte('snapshot_date', w7.windowEnd)
    .limit(50_000)

  if (error) {
    return emptyBundle('gsc', filters, categories, markets, `GSC query error: ${error.message}`)
  }
  const snaps = (snapsRaw ?? []) as Array<{
    snapshot_date: string
    page:          string
    query:         string
    clicks:        number
    impressions:   number
    position:      number
  }>

  // ── Helper: match GSC `page` to a product URL ──────────────────────────────
  // The page can have query strings / trailing slashes / locale prefixes that
  // the canonical product.url doesn't. Compare on pathname prefix.
  function pathOf(rawUrl: string): string {
    try { return new URL(rawUrl).pathname.replace(/\/+$/, '') } catch { return rawUrl.replace(/\/+$/, '') }
  }
  const productByPath = new Map<string, typeof products[0]>()
  for (const p of products) {
    if (!p.url) continue
    const path = pathOf(p.url)
    if (path) productByPath.set(path, p)
  }
  function matchProduct(page: string): typeof products[0] | null {
    const pPath = pathOf(page)
    // Try exact match first (cheap, common case)
    const exact = productByPath.get(pPath)
    if (exact) return exact
    // Fallback: longest prefix match (handles trailing locale, slugs)
    let best: typeof products[0] | null = null
    let bestLen = 0
    for (const [path, prod] of productByPath) {
      if (pPath.startsWith(path) && path.length > bestLen) {
        best = prod
        bestLen = path.length
      }
    }
    return best
  }

  // ── Aggregate per (product × kw) for the 7d window AND 28d windows ─────────
  type AggCell = { impressions: number; clicks: number; posWeighted: number }
  function emptyCell(): AggCell { return { impressions: 0, clicks: 0, posWeighted: 0 } }

  const agg7  = new Map<string, AggCell>()  // key: productId|kw
  const agg28 = new Map<string, AggCell>()
  const agg28Prior = new Map<string, AggCell>()
  const productAgg7  = new Map<string, AggCell>()  // key: productId
  const productAgg28 = new Map<string, AggCell>()
  const productAgg28Prior = new Map<string, AggCell>()

  // Per-week bucketing for the 8-week distribution chart. Key = ISO week-end
  // date (Sunday). Each (kw × product) contributes its impression-weighted
  // avg position to the bucket boundaries (top3/top10/etc.).
  type WeekAgg = { kws: Map<string, AggCell> }  // key: productId|kw → cell
  const weekly = new Map<string, WeekAgg>()

  function bumpCell(map: Map<string, AggCell>, key: string, clicks: number, impressions: number, position: number): void {
    const cell = map.get(key) ?? emptyCell()
    cell.clicks      += clicks
    cell.impressions += impressions
    cell.posWeighted += position * impressions   // impression-weighted accumulator
    map.set(key, cell)
  }

  let queriesMatched = 0
  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q) continue
    // Discovery mode allows all queries; here in tracked-mode we only care
    // about queries on our kw list.
    if (!allKwLower.has(q)) continue
    const prod = matchProduct(r.page)
    if (!prod) continue
    const kwSet = kwByProduct.get(prod.id)
    if (!kwSet?.has(q)) continue  // this kw isn't tracked for THIS product

    queriesMatched++
    const key = `${prod.id}|${q}`

    // Current 7d window
    if (r.snapshot_date >= w7.windowStart && r.snapshot_date <= w7.windowEnd) {
      bumpCell(agg7, key, r.clicks, r.impressions, r.position)
      bumpCell(productAgg7, prod.id, r.clicks, r.impressions, r.position)
    }
    // Current 28d window
    if (r.snapshot_date >= w28.windowStart && r.snapshot_date <= w28.windowEnd) {
      bumpCell(agg28, key, r.clicks, r.impressions, r.position)
      bumpCell(productAgg28, prod.id, r.clicks, r.impressions, r.position)
    }
    // Prior 28d window
    if (r.snapshot_date >= w28.priorStart && r.snapshot_date <= w28.priorEnd) {
      bumpCell(agg28Prior, key, r.clicks, r.impressions, r.position)
      bumpCell(productAgg28Prior, prod.id, r.clicks, r.impressions, r.position)
    }

    // Per-week bucket for chart — round snapshot_date forward to Sunday end-of-week
    const d = new Date(r.snapshot_date)
    const dayOfWeek = d.getUTCDay()                            // 0=Sun, 6=Sat
    const sundayOffset = (7 - dayOfWeek) % 7
    const weekEnd = isoDate(addDays(d, sundayOffset))
    const wk = weekly.get(weekEnd) ?? { kws: new Map<string, AggCell>() }
    bumpCell(wk.kws, key, r.clicks, r.impressions, r.position)
    weekly.set(weekEnd, wk)
  }

  // ── Compute KPIs from 7d window ────────────────────────────────────────────
  // Avg position = impression-weighted across all (product × kw) pairs.
  let totalImp7 = 0
  let totalClk7 = 0
  let totalPosImpWeighted7 = 0
  let top3_7 = 0, top10_7 = 0, top20_7 = 0, notRank7 = 0
  for (const [, cell] of agg7) {
    if (cell.impressions === 0) { notRank7++; continue }
    totalImp7 += cell.impressions
    totalClk7 += cell.clicks
    totalPosImpWeighted7 += cell.posWeighted
    const avgPos = cell.posWeighted / cell.impressions
    if (avgPos <= TOP_3_BOUNDARY)       top3_7++
    else if (avgPos <= 10)               top10_7++
    else if (avgPos <= 20)               top20_7++
  }
  const avgPos7 = totalImp7 > 0 ? +(totalPosImpWeighted7 / totalImp7).toFixed(2) : null

  // Prior 28d → 28d delta (for WoW signals)
  let totalImp28 = 0, totalImp28Prior = 0
  let totalClk28 = 0, totalClk28Prior = 0
  let totalPosImpWeighted28 = 0, totalPosImpWeighted28Prior = 0
  let top3_28 = 0, top3_28Prior = 0
  let top10_28 = 0, top10_28Prior = 0
  let notRank28 = 0, notRank28Prior = 0

  for (const [key, cur] of agg28) {
    const prior = agg28Prior.get(key)
    if (cur.impressions === 0) notRank28++
    else {
      totalImp28 += cur.impressions
      totalClk28 += cur.clicks
      totalPosImpWeighted28 += cur.posWeighted
      const avgPos = cur.posWeighted / cur.impressions
      if (avgPos <= TOP_3_BOUNDARY) top3_28++
      else if (avgPos <= 10)         top10_28++
    }
    if (prior) {
      if (prior.impressions === 0) notRank28Prior++
      else {
        totalImp28Prior += prior.impressions
        totalClk28Prior += prior.clicks
        totalPosImpWeighted28Prior += prior.posWeighted
        const avgPos = prior.posWeighted / prior.impressions
        if (avgPos <= TOP_3_BOUNDARY) top3_28Prior++
        else if (avgPos <= 10)         top10_28Prior++
      }
    }
  }
  // Catch keys present only in the prior window (kws that fell out)
  for (const [key, prior] of agg28Prior) {
    if (agg28.has(key)) continue
    if (prior.impressions === 0) notRank28Prior++
    else {
      totalImp28Prior += prior.impressions
      totalClk28Prior += prior.clicks
      totalPosImpWeighted28Prior += prior.posWeighted
      const avgPos = prior.posWeighted / prior.impressions
      if (avgPos <= TOP_3_BOUNDARY) top3_28Prior++
      else if (avgPos <= 10)         top10_28Prior++
    }
  }

  const avgPos28      = totalImp28      > 0 ? totalPosImpWeighted28      / totalImp28      : null
  const avgPos28Prior = totalImp28Prior > 0 ? totalPosImpWeighted28Prior / totalImp28Prior : null

  const kpis: Kpis = {
    kwTracked:        agg7.size + notRank7,   // matched + not-ranking-in-7d
    avgPosition:      avgPos7,
    avgPositionDelta: (avgPos28 != null && avgPos28Prior != null) ? +(avgPos28Prior - avgPos28).toFixed(2) : null,
    top3:             top3_7,
    top3Delta:        top3_28 - top3_28Prior,
    top10:            top10_7,
    top10Delta:       top10_28 - top10_28Prior,
    top20:            top20_7,
    notRanking:       notRank7,
    notRankingDelta:  notRank28 - notRank28Prior,
    totalImpressions:      totalImp7,
    totalImpressionsDelta: totalImp28 - totalImp28Prior,
    totalClicks:           totalClk7,
    totalClicksDelta:      totalClk28 - totalClk28Prior,
  }

  // ── Distribution chart — 8 weeks ───────────────────────────────────────────
  const distribution: DistributionPoint[] = []
  const sortedWeeks = Array.from(weekly.entries()).sort(([a], [b]) => a.localeCompare(b)).slice(-8)
  for (const [weekEnd, wk] of sortedWeeks) {
    const buckets = { top3: 0, top10: 0, top20: 0, top50: 0, outside: 0 }
    for (const [, cell] of wk.kws) {
      if (cell.impressions === 0) { buckets.outside++; continue }
      const avgPos = cell.posWeighted / cell.impressions
      if (avgPos <= TOP_3_BOUNDARY)   buckets.top3++
      else if (avgPos <= 10)           buckets.top10++
      else if (avgPos <= 20)           buckets.top20++
      else if (avgPos <= 50)           buckets.top50++
      else                              buckets.outside++
    }
    distribution.push({ date: weekEnd, ...buckets })
  }

  // ── Movers (gainers + losers) — 28d vs prior 28d on avg position ───────────
  const movers: Mover[] = []
  for (const [key, cur] of agg28) {
    const prior = agg28Prior.get(key)
    if (!prior) continue
    const curPos   = cur.impressions   > 0 ? cur.posWeighted   / cur.impressions   : null
    const priorPos = prior.impressions > 0 ? prior.posWeighted / prior.impressions : null
    if (curPos == null && priorPos == null) continue
    let delta = 0
    if (curPos != null && priorPos != null) delta = priorPos - curPos        // positive = improved
    else if (curPos == null && priorPos != null) delta = -50                  // fell out
    else if (curPos != null && priorPos == null) delta = +50                  // entered
    if (Math.abs(delta) < 0.1) continue
    const [productId, keyword] = key.split('|')
    const prod = products.find(p => p.id === productId)
    movers.push({
      productName: prod?.product_name ?? '(unknown)',
      keyword,
      market:      prod?.market ?? 'us',
      prevPos:     priorPos != null ? +priorPos.toFixed(1) : null,
      currPos:     curPos   != null ? +curPos.toFixed(1)   : null,
      delta:       +delta.toFixed(1),
    })
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const gainers = movers.filter(m => m.delta > 0).slice(0, 5)
  const losers  = movers.filter(m => m.delta < 0).slice(0, 5)

  // ── Per-product summary ────────────────────────────────────────────────────
  const productSummaries: ProductSummary[] = products.map(p => {
    const cell7 = productAgg7.get(p.id)
    const cell28      = productAgg28.get(p.id)
    const cell28Prior = productAgg28Prior.get(p.id)
    // Count kws this product has in tier_keywords
    const productKws = kwByProduct.get(p.id)?.size ?? 0
    const avgPos = (cell7 && cell7.impressions > 0) ? +(cell7.posWeighted / cell7.impressions).toFixed(2) : null
    let top3 = 0, top10 = 0
    for (const [key, cell] of agg7) {
      if (!key.startsWith(`${p.id}|`)) continue
      if (cell.impressions === 0) continue
      const ap = cell.posWeighted / cell.impressions
      if (ap <= TOP_3_BOUNDARY) top3++
      else if (ap <= 10)         top10++
    }
    // WoW = 28d vs prior 28d on product-level avg
    let wowDelta: number | null = null
    if (cell28 && cell28.impressions > 0 && cell28Prior && cell28Prior.impressions > 0) {
      const cur28   = cell28.posWeighted   / cell28.impressions
      const prior28 = cell28Prior.posWeighted / cell28Prior.impressions
      wowDelta = +(prior28 - cur28).toFixed(2)
    }
    return {
      id:               p.id,
      productName:      p.product_name,
      tier:             p.tier,
      category:         p.category,
      url:              p.url,
      restriction_type: p.restriction_type,
      market:           p.market,
      kwCount:          productKws,
      avgPosition:      avgPos,
      top3,
      top10,
      wowDelta,
      impressions:      cell7?.impressions ?? 0,
      clicks:           cell7?.clicks      ?? 0,
    }
  }).sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return (a.avgPosition ?? 999) - (b.avgPosition ?? 999)
  })

  return {
    source:      'gsc',
    filters,
    kpis,
    distribution,
    topMovers:   { gainers, losers },
    products:    productSummaries,
    competitors: [],   // GSC doesn't expose competitor SERPs; UI hides this in GSC mode
    categories,
    markets,
    meta: {
      windowStart: w7.windowStart,
      windowEnd:   w7.windowEnd,
      priorStart:  w28.priorStart,
      priorEnd:    w28.priorEnd,
      snapshotsScanned: snaps.length,
      queriesMatched,
    },
  }
}

// ─── Discovery builder (top GSC queries per product, ignore tier_keywords) ──

/**
 * Fetch top GSC queries for each product URL regardless of whether the
 * keyword is curated. Sorted by impressions desc within each product.
 *
 * Use case: "we already track 30 kws for Genshin — what else is people
 * actually searching for that lands on the Genshin page?" Returns surfacing
 * winners we never thought to track.
 *
 * Output shape adapted to RankingsBundle for UI symmetry: the `products`
 * array is per-product totals, but the page in discovery mode renders a
 * flat list of (product, query, impressions, clicks, position) instead.
 * Movers + competitors are empty (not meaningful here).
 */
export async function fetchRankingsGSCDiscovery(opts: FetchOpts): Promise<RankingsBundle & {
  discoveryRows: Array<{
    productId:     string
    productName:   string
    query:         string
    impressions:   number
    clicks:        number
    avgPosition:   number
    isTracked:     boolean
  }>
}> {
  const { db, ownerId, products, filters, categories, markets, gscPropertyUrl } = opts

  if (!gscPropertyUrl || products.length === 0) {
    return {
      ...emptyBundle('gsc-discovery', filters, categories, markets, !gscPropertyUrl ? 'No GSC property configured' : undefined),
      discoveryRows: [],
    }
  }

  // Load tracked kws (so we can flag isTracked)
  const productIds = products.map(p => p.id)
  const { data: kwRows } = await db
    .from('tier_keywords')
    .select('product_tier_id, keyword')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
  const trackedSet = new Set<string>()
  for (const r of (kwRows ?? [])) {
    trackedSet.add(`${r.product_tier_id}|${String(r.keyword).toLowerCase().trim()}`)
  }

  const now = new Date()
  const w7  = windowRange(now, GSC_WINDOW_DAYS, GSC_LAG_DAYS)

  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', w7.windowStart)
    .lte('snapshot_date', w7.windowEnd)
    .limit(25_000)

  if (error) {
    return {
      ...emptyBundle('gsc-discovery', filters, categories, markets, `GSC query error: ${error.message}`),
      discoveryRows: [],
    }
  }
  const snaps = (snapsRaw ?? []) as Array<{
    snapshot_date: string
    page:          string
    query:         string
    clicks:        number
    impressions:   number
    position:      number
  }>

  function pathOf(rawUrl: string): string {
    try { return new URL(rawUrl).pathname.replace(/\/+$/, '') } catch { return rawUrl.replace(/\/+$/, '') }
  }
  const productByPath = new Map<string, typeof products[0]>()
  for (const p of products) {
    if (!p.url) continue
    const path = pathOf(p.url)
    if (path) productByPath.set(path, p)
  }
  function matchProduct(page: string): typeof products[0] | null {
    const pPath = pathOf(page)
    const exact = productByPath.get(pPath)
    if (exact) return exact
    let best: typeof products[0] | null = null
    let bestLen = 0
    for (const [path, prod] of productByPath) {
      if (pPath.startsWith(path) && path.length > bestLen) {
        best = prod
        bestLen = path.length
      }
    }
    return best
  }

  // Aggregate per (product × query) over 7d
  type Cell = { impressions: number; clicks: number; posWeighted: number }
  const agg = new Map<string, Cell>()
  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q) continue
    const prod = matchProduct(r.page)
    if (!prod) continue
    const key = `${prod.id}|${q}`
    const cell = agg.get(key) ?? { impressions: 0, clicks: 0, posWeighted: 0 }
    cell.impressions += r.impressions
    cell.clicks      += r.clicks
    cell.posWeighted += r.position * r.impressions
    agg.set(key, cell)
  }

  const discoveryRows = Array.from(agg.entries())
    .filter(([, cell]) => cell.impressions > 0)
    .map(([key, cell]) => {
      const [productId, query] = key.split('|')
      const prod = products.find(p => p.id === productId)
      return {
        productId,
        productName:  prod?.product_name ?? '(unknown)',
        query,
        impressions:  cell.impressions,
        clicks:       cell.clicks,
        avgPosition:  +(cell.posWeighted / cell.impressions).toFixed(2),
        isTracked:    trackedSet.has(key),
      }
    })
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 500)   // cap for UI

  return {
    ...emptyBundle('gsc-discovery', filters, categories, markets),
    meta: {
      windowStart: w7.windowStart,
      windowEnd:   w7.windowEnd,
      priorStart:  null,
      priorEnd:    null,
      snapshotsScanned: snaps.length,
      queriesMatched:   discoveryRows.length,
    },
    discoveryRows,
  }
}

// ─── Empty / fallback ──────────────────────────────────────────────────────

function emptyBundle(
  source:     DataSource,
  filters:    Record<string, string>,
  categories: string[],
  markets:    readonly string[],
  error?:     string,
): RankingsBundle {
  const empty: Kpis = {
    kwTracked: 0, avgPosition: null, avgPositionDelta: null,
    top3: 0, top3Delta: 0, top10: 0, top10Delta: 0, top20: 0,
    notRanking: 0, notRankingDelta: 0,
    totalImpressions: null, totalImpressionsDelta: null,
    totalClicks: null, totalClicksDelta: null,
  }
  return {
    source,
    filters: error ? { ...filters, _error: error } : filters,
    kpis:         empty,
    distribution: [],
    topMovers:    { gainers: [], losers: [] },
    products:     [],
    competitors:  [],
    categories,
    markets,
    meta: { windowStart: null, windowEnd: null, priorStart: null, priorEnd: null, snapshotsScanned: 0, queriesMatched: 0 },
  }
}
