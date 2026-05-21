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

// Sprint PP.GSC.TOGGLE.FIX — snapshot-based semantics.
// The window/lag constants are gone; we instead use whatever snapshot dates
// are actually present in the data. Prior comparison still targets ~28d.
const GSC_WOW_COMPARE_DAYS = 28
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
  /** Sprint PP.GSC.MATCH.HINT — How many tier_keywords actually have GSC impressions in the current window.
   *  Always null in DFS mode (DFS scrapes every kw regardless of search volume).
   *  In GSC modes, `matchedKws / kwCount` tells the user "how much real-world signal we have". */
  matchedKws:       number | null
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

// (windowRange helper removed in Sprint PP.GSC.TOGGLE.FIX — snapshot-based
//  semantics make calendar windows unnecessary.)

// ─── Locale prefix stripping (Sprint PP.GSC.URL.LOCALE) ────────────────────
//
// G2G and OffGamers serve localized URLs like /id/categories/X, /cn/categories/X.
// Canonical product_tiers.url is stored without locale prefix, so a naive path
// match misses all localized impressions. Strip the prefix before comparing.
const LOCALE_PREFIXES = [
  // Asia
  'id', 'cn', 'jp', 'kr', 'tw', 'hk', 'sg', 'my', 'ph', 'th', 'vi', 'in',
  // EU
  'en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'pl', 'nl', 'tr', 'sv', 'no', 'da', 'fi',
  // Americas
  'us', 'br', 'mx', 'ar',
  // Other
  'ar-sa', 'pt-br', 'zh-cn', 'zh-tw', 'en-us', 'en-gb', 'es-mx',
]
const LOCALE_SET = new Set(LOCALE_PREFIXES)

/** Strip locale prefix from a pathname. Idempotent. */
export function stripLocale(path: string): string {
  if (!path || path === '/') return path
  const trimmed = path.replace(/^\/+/, '')
  const slashIdx = trimmed.indexOf('/')
  const firstSeg = slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx)
  if (LOCALE_SET.has(firstSeg.toLowerCase())) {
    return slashIdx === -1 ? '/' : '/' + trimmed.slice(slashIdx + 1)
  }
  return path
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
 * Snapshot semantics (Sprint PP.GSC.TOGGLE.1 → revised 2026-05-21):
 *
 *   Each row in gsc_query_snapshots represents a 7-day GSC rollup CAPTURED
 *   on a specific date. The cron writes with snapshot_date=today, and Hugin
 *   baseline writes with snapshot_date=week.end. Both have the same shape:
 *   one row per (page × query × snapshot_date) where the row's metrics are
 *   already a 7-day aggregate ending at/around the snapshot_date.
 *
 *   So we treat each snapshot as a point-in-time observation. For each
 *   (product × keyword) pair:
 *     • current  = the LATEST snapshot we have
 *     • prior    = a snapshot ~28 days earlier (closest match within ±5d)
 *
 *   The chart's X axis = the actual snapshot_dates present in the data,
 *   not arbitrary calendar weeks. So if cron has run on May 7, 14, 21 we
 *   show 3 buckets; if Hugin baseline filled in March data too, we show
 *   those buckets as well.
 *
 *   This makes the page resilient to:
 *     - Different cron cadences (daily vs weekly)
 *     - Mixed data sources (baseline backfill + ongoing daily)
 *     - Missing intermediate weeks (we just skip them)
 *
 * Matching strategy: for each product we know its `url`. We find GSC rows
 * whose `page` starts with `product.url` AND whose `query` matches a kw in
 * tier_keywords for that product.
 *
 * Rows with 0 impressions are EXCLUDED (no signal to draw from).
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

  // ── Fetch ALL snapshots from the past 120 days (matches table retention) ──
  // We bucket by snapshot_date in JS, then pick latest/prior per (kw, product).
  const now = new Date()
  const fetchSince = isoDate(addDays(now, -120))

  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', fetchSince)
    .order('snapshot_date', { ascending: false })
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
  function pathOf(rawUrl: string): string {
    let p: string
    try { p = new URL(rawUrl).pathname } catch { p = rawUrl }
    p = stripLocale(p).replace(/\/+$/, '')
    return p
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

  // ── Group all matching snapshots by (product × kw × snapshot_date) ────────
  // Each cell aggregates if there are multiple rows for same (key, date)
  // due to e.g. multiple sub-pages of same product. Then we pick the latest
  // and prior per kw, regardless of calendar week.
  type AggCell = { impressions: number; clicks: number; posWeighted: number }
  function emptyCell(): AggCell { return { impressions: 0, clicks: 0, posWeighted: 0 } }
  function bumpCell(cell: AggCell, clicks: number, impressions: number, position: number): void {
    cell.clicks      += clicks
    cell.impressions += impressions
    cell.posWeighted += position * impressions
  }

  // observations[productId|kw] = sorted list of { date, cell } latest-first
  const observations = new Map<string, Array<{ date: string; cell: AggCell }>>()
  const distinctDates = new Set<string>()
  let queriesMatched = 0

  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q) continue
    if (!allKwLower.has(q)) continue
    const prod = matchProduct(r.page)
    if (!prod) continue
    const kwSet = kwByProduct.get(prod.id)
    if (!kwSet?.has(q)) continue

    queriesMatched++
    const key = `${prod.id}|${q}`
    distinctDates.add(r.snapshot_date)

    let list = observations.get(key)
    if (!list) { list = []; observations.set(key, list) }
    // Find or append the cell for this date
    let entry = list.find(e => e.date === r.snapshot_date)
    if (!entry) {
      entry = { date: r.snapshot_date, cell: emptyCell() }
      list.push(entry)
    }
    bumpCell(entry.cell, r.clicks, r.impressions, r.position)
  }
  // Sort each list latest-first (snapshots come from DB sorted desc but
  // re-sort after the inner-merge above just to be safe)
  for (const list of observations.values()) {
    list.sort((a, b) => b.date.localeCompare(a.date))
  }

  // ── Determine the canonical "current" + "prior" date for the whole report ─
  // Current = the latest snapshot_date present across all observations.
  // Prior   = a snapshot date roughly 28 days before current (closest within ±5d).
  const sortedDates = Array.from(distinctDates).sort((a, b) => b.localeCompare(a))
  const currentDate: string | null = sortedDates[0] ?? null
  let priorDate: string | null = null
  if (currentDate) {
    const targetMs = new Date(currentDate).getTime() - GSC_WOW_COMPARE_DAYS * 86_400_000
    let bestDiff = Infinity
    for (const d of sortedDates) {
      if (d >= currentDate) continue
      const diff = Math.abs(new Date(d).getTime() - targetMs)
      if (diff < bestDiff) { bestDiff = diff; priorDate = d }
    }
  }

  // ── Aggregate per-kw using latest + prior snapshots ────────────────────────
  const agg7  = new Map<string, AggCell>()  // latest snapshot per kw
  const agg28Prior = new Map<string, AggCell>()
  const productAgg7  = new Map<string, AggCell>()
  const productAgg28Prior = new Map<string, AggCell>()

  for (const [key, list] of observations) {
    const productId = key.split('|')[0]
    const latest = list[0]   // already sorted latest-first
    if (latest) {
      agg7.set(key, latest.cell)
      const prodCell = productAgg7.get(productId) ?? emptyCell()
      prodCell.clicks      += latest.cell.clicks
      prodCell.impressions += latest.cell.impressions
      prodCell.posWeighted += latest.cell.posWeighted
      productAgg7.set(productId, prodCell)
    }
    // Find prior snapshot for this kw (closest to currentDate-28d)
    if (currentDate) {
      const targetMs = new Date(currentDate).getTime() - GSC_WOW_COMPARE_DAYS * 86_400_000
      let bestEntry: { date: string; cell: AggCell } | null = null
      let bestDiff = Infinity
      for (const entry of list) {
        if (entry.date >= currentDate) continue
        const diff = Math.abs(new Date(entry.date).getTime() - targetMs)
        if (diff < bestDiff) { bestDiff = diff; bestEntry = entry }
      }
      if (bestEntry) {
        agg28Prior.set(key, bestEntry.cell)
        const prodCell = productAgg28Prior.get(productId) ?? emptyCell()
        prodCell.clicks      += bestEntry.cell.clicks
        prodCell.impressions += bestEntry.cell.impressions
        prodCell.posWeighted += bestEntry.cell.posWeighted
        productAgg28Prior.set(productId, prodCell)
      }
    }
  }

  // The lib historically named these agg7/agg28; with the snapshot-based
  // rewrite they're really "current" and "prior". Aliasing here so the
  // downstream KPI/movers logic stays unchanged.
  const agg28 = agg7
  const productAgg28 = productAgg7

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

  // ── Distribution chart — one bucket per snapshot_date we actually have ────
  // No calendar-week bucketing. The X axis = chronological snapshot_dates.
  // This matches the new snapshot-based semantics — if cron ran 5 times,
  // we show 5 buckets. If Hugin baseline filled in March + cron has been
  // adding daily since, all those dates show as separate buckets.
  const distribution: DistributionPoint[] = []
  const ascDates = sortedDates.slice().reverse().slice(-12)   // last 12 snapshot dates
  // Build per-date aggregation by going through observations
  const byDate = new Map<string, AggCell[]>()   // date → list of cells (per kw)
  for (const list of observations.values()) {
    for (const entry of list) {
      const arr = byDate.get(entry.date) ?? []
      arr.push(entry.cell)
      byDate.set(entry.date, arr)
    }
  }
  for (const date of ascDates) {
    const cells = byDate.get(date) ?? []
    const buckets = { top3: 0, top10: 0, top20: 0, top50: 0, outside: 0 }
    for (const cell of cells) {
      if (cell.impressions === 0) { buckets.outside++; continue }
      const avgPos = cell.posWeighted / cell.impressions
      if (avgPos <= TOP_3_BOUNDARY)   buckets.top3++
      else if (avgPos <= 10)           buckets.top10++
      else if (avgPos <= 20)           buckets.top20++
      else if (avgPos <= 50)           buckets.top50++
      else                              buckets.outside++
    }
    distribution.push({ date, ...buckets })
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
    let matchedKws = 0   // Sprint PP.GSC.MATCH.HINT — count tier_keywords that actually have GSC signal
    for (const [key, cell] of agg7) {
      if (!key.startsWith(`${p.id}|`)) continue
      if (cell.impressions === 0) continue
      matchedKws++
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
      matchedKws,
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
      // Snapshot-based: surface the actual current + prior dates we used.
      // null when we don't have any data yet for that side.
      windowStart: currentDate,
      windowEnd:   currentDate,
      priorStart:  priorDate,
      priorEnd:    priorDate,
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

  // Pull last 14 days of snapshots (forgiving — handles cron not running yesterday).
  // Per (product × query) we'll use the LATEST snapshot to surface volume.
  const now = new Date()
  const fetchSinceDisc = isoDate(addDays(now, -14))

  const { data: snapsRaw, error } = await db
    .from('gsc_query_snapshots')
    .select('snapshot_date, page, query, clicks, impressions, position')
    .eq('site_url', gscPropertyUrl)
    .gte('snapshot_date', fetchSinceDisc)
    .order('snapshot_date', { ascending: false })
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
    let p: string
    try { p = new URL(rawUrl).pathname } catch { p = rawUrl }
    p = stripLocale(p).replace(/\/+$/, '')
    return p
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

  // Take the LATEST snapshot per (product × query). Since snapshots are
  // already sorted desc by date, we just take the first occurrence of each key.
  type Cell = { impressions: number; clicks: number; posWeighted: number }
  const agg = new Map<string, Cell>()
  const seen = new Set<string>()
  for (const r of snaps) {
    const q = String(r.query ?? '').toLowerCase().trim()
    if (!q) continue
    const prod = matchProduct(r.page)
    if (!prod) continue
    const key = `${prod.id}|${q}`
    if (seen.has(key)) continue   // already captured latest for this kw
    seen.add(key)
    agg.set(key, {
      impressions: r.impressions,
      clicks:      r.clicks,
      posWeighted: r.position * r.impressions,
    })
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

  // Latest snapshot_date present is our "window"
  const latestDate = snaps[0]?.snapshot_date ?? null
  return {
    ...emptyBundle('gsc-discovery', filters, categories, markets),
    meta: {
      windowStart: latestDate,
      windowEnd:   latestDate,
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
