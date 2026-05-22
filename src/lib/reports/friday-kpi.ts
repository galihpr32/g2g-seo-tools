// Sprint FRIDAY.KPI (v2) — KPI Dashboard rewrite.
//
// Old version was a generic action-items digest. The spec was actually a
// per-(brand × market) KPI dashboard:
//
//   🥇 MOST COMPETITIVE KEYWORD RANKINGS
//       For each brand × market: Avg pos, Top 3, Top 10 — all with WoW delta
//   📈 SEO TRAFFIC — Clicks WoW
//       Per-brand totals last 7d vs prior 7d (GSC)
//   📈 SEO TRAFFIC — Impressions WoW
//       Same matrix
//
// "Most competitive" = all keywords currently tracked in tier_keywords
// for products on this brand (they're pre-curated as priority — counts as
// the competitive set). When SV data is available, we surface it; when
// not, we still report the structural KPIs.
//
// Market mapping per the wider app: 'us' → "Global", 'id' → "ID".

import type { SupabaseClient } from '@supabase/supabase-js'
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics, getDateRange } from '@/lib/gsc/client'
import { buildAiVisibilityForKpi, type FridayKpiAiSlice } from '@/lib/agents/freyja'
import { getFridayKpiCanon, type CanonSource } from '@/lib/reports/friday-kpi-canon'

export const MARKET_LABELS: Record<string, string> = { us: 'Global', id: 'ID' }
const MARKETS = ['us', 'id'] as const
type Market = typeof MARKETS[number]

const WOW_DAYS = 7

export interface MarketKpi {
  market:         Market
  market_label:   string
  /** Sprint COMPETITIVE.SCORER.4 — count of cluster winners (top 3 per cluster
   *  by competitive_score). Replaces the old "all tracked kws" count so the
   *  section title "Most Competitive Keyword Rankings" matches reality. */
  kw_count:       number
  avg_position:   number | null
  avg_pos_delta:  number | null         // positive = improved
  top3:           number
  top3_delta:     number
  top10:          number
  top10_delta:    number
  /** Sprint COMPETITIVE.SCORER.4 — coverage signal for the digest footer.
   *  Clusters = priority products targeting this market.
   *  coverage_total = number of clusters that exist for this brand × market.
   *  coverage_with_winner = clusters that have at least 1 cluster_winner.
   *  Helps surface: "G2G Global has 22/26 clusters with a winner tracked". */
  coverage_total:        number
  coverage_with_winner:  number
}

export interface ClickKpi {
  market:        Market
  market_label:  string
  clicks:        number
  clicks_pct:    number | null          // WoW % (positive = up)
  impressions:   number
  imp_pct:       number | null
}

export interface BrandKpi {
  site_slug:    string
  serp:         MarketKpi[]
  traffic:      ClickKpi[]
}

export interface ForsetiBrandSlice {
  site_slug:           string
  spotted_this_week:   number
  responded:           number
  response_rate_pct:   number
  sev4plus_pending:    number
  avg_response_time_h: number | null
  by_category:         Array<{ category: string; count: number }>
  resolved_this_week:  number
  escalated_this_week: number
}

export interface FridayKpiPayload {
  week_label:   string
  iso_week:     number
  generated_at: string
  brands:       BrandKpi[]
  /** Public weekly report URL (kalau ada) */
  public_url:   string | null
  /** Methodology page URL */
  methodology_url: string
  /** Priority products page URL */
  priority_url:    string
  /** Sprint FREYJA — AI Visibility slice per brand */
  ai_visibility:   FridayKpiAiSlice[]
  /** Direct link to AI Visibility dashboard */
  ai_visibility_url: string
  /** Sprint FORSETI.DIGEST — Community response slice per brand */
  forseti:         ForsetiBrandSlice[]
  /** Direct link to Forseti triage queue */
  forseti_url:     string
  /** Sprint FRIDAY.KPI.GRAPH.1 — which data source is canonical for this report.
   *  'gsc' = real-world impressions/clicks-weighted. 'dfs' = DataForSEO scrape.
   *  Default 'gsc'. UI + PNG renderer show this as a tag. */
  canon_source:    CanonSource
}

/**
 * Build the KPI payload across the given brands. Per-brand × per-market
 * lookups are done sequentially to keep this readable; total queries
 * scale as O(brands × markets × 2) which is small.
 */
export async function buildFridayKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
): Promise<FridayKpiPayload> {
  // Sprint FRIDAY.KPI.GRAPH.1 — resolve canon source. Per-brand builders read
  // this to decide whether to pull from tier_serp_snapshots (DFS) or
  // gsc_query_snapshots (GSC, impression-weighted). Default 'gsc'.
  const canonSource = await getFridayKpiCanon(db, ownerId)

  const brands: BrandKpi[] = []
  for (const slug of siteSlugs) {
    // eslint-disable-next-line no-await-in-loop
    const brand = await buildBrandKpi(db, ownerId, slug)
    brands.push(brand)
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')

  // Sprint FREYJA — AI Visibility slice per brand. Graceful: if Freyja table
  // is empty (e.g. fresh deploy, no imports yet), returns 0s without crashing.
  let aiVisibility: FridayKpiAiSlice[] = []
  try {
    aiVisibility = await buildAiVisibilityForKpi(db, ownerId, siteSlugs)
  } catch (e) {
    console.warn('[friday-kpi] AI visibility slice failed, continuing without it:', e)
  }

  // Sprint FORSETI.DIGEST — Community response slice per brand. Graceful:
  // if no Forseti configs yet, returns zero rows so the digest block hides.
  const forseti: ForsetiBrandSlice[] = []
  try {
    const { computeForsetiStats } = await import('@/app/api/forseti/stats/route')
    for (const slug of siteSlugs) {
      // eslint-disable-next-line no-await-in-loop
      const s = await computeForsetiStats(db, ownerId, slug, 7)
      forseti.push({
        site_slug:           slug,
        spotted_this_week:   s.spotted_this_week,
        responded:           s.responded,
        response_rate_pct:   s.response_rate_pct,
        sev4plus_pending:    s.sev4plus_pending,
        avg_response_time_h: s.avg_response_time_h,
        by_category:         s.by_category,
        resolved_this_week:  s.resolved_this_week,
        escalated_this_week: s.escalated_this_week,
      })
    }
  } catch (e) {
    console.warn('[friday-kpi] Forseti slice failed, continuing without it:', e)
  }

  return {
    week_label:   weekLabel(),
    iso_week:     isoWeek(),
    generated_at: new Date().toISOString(),
    brands,
    public_url:        appUrl ? `${appUrl}/reports/weekly` : null,
    methodology_url:   `${appUrl}/methodology/competitive-keywords`,
    priority_url:      `${appUrl}/priority-products`,
    ai_visibility:     aiVisibility,
    ai_visibility_url: `${appUrl}/reports/ai-visibility`,
    forseti,
    forseti_url:       `${appUrl}/forseti`,
    canon_source:      canonSource,
  }
}

async function buildBrandKpi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
): Promise<BrandKpi> {
  // ── Per-market SERP aggregates ────────────────────────────────────────
  const serp: MarketKpi[] = []
  for (const market of MARKETS) {
    // eslint-disable-next-line no-await-in-loop
    const m = await buildMarketSerp(db, ownerId, siteSlug, market)
    serp.push(m)
  }

  // ── Per-market traffic (GSC clicks + impressions) ──────────────────────
  const traffic = await buildBrandTraffic(db, ownerId, siteSlug)

  return { site_slug: siteSlug, serp, traffic }
}

async function buildMarketSerp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
  market:   Market,
): Promise<MarketKpi> {
  const empty: MarketKpi = {
    market, market_label: MARKET_LABELS[market], kw_count: 0,
    avg_position: null, avg_pos_delta: null,
    top3: 0, top3_delta: 0,
    top10: 0, top10_delta: 0,
    coverage_total: 0, coverage_with_winner: 0,
  }

  // 1. Find tier-product IDs for this brand × market.
  // Sprint TIER.PER.MARKET — same product can have separate rows for us + id
  // tiers. Only include rows whose target market matches the column being
  // built, so Global cell shows ONLY products targeted at US, and ID cell
  // shows ONLY products targeted at ID.
  const { data: products } = await db
    .from('product_tiers')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('market', market)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pIds = ((products ?? []) as any[]).map(p => String(p.id))
  if (pIds.length === 0) return empty

  // Sprint COMPETITIVE.SCORER.4 — Pull cluster winners for this brand × market.
  // We need:
  //   • the set of winner keywords (for filtering snapshots)
  //   • per-product winner count (for coverage stat: "X out of Y clusters have ≥1 winner")
  const { data: winnerRows } = await db
    .from('tier_keywords')
    .select('id, keyword, product_tier_id')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', pIds)
    .eq('cluster_market', market)
    .eq('is_cluster_winner', true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const winners = (winnerRows ?? []) as Array<{ id: string; keyword: string; product_tier_id: string }>

  // Winner KW set for snapshot filter — keyed by (product_tier_id|keyword.lower)
  const winnerKeySet = new Set(winners.map(w => `${w.product_tier_id}|${w.keyword.toLowerCase()}`))
  const winnerIdSet  = new Set(winners.map(w => w.id))

  // Coverage: products in this market that have at least 1 winner tracked
  const productsWithWinner = new Set(winners.map(w => w.product_tier_id))
  const coverageTotal       = pIds.length
  const coverageWithWinner  = productsWithWinner.size

  // If no winners scored yet, return empty + just the coverage signal.
  // Helps users distinguish "scoring hasn't run" from "no SERP data".
  if (winners.length === 0) {
    return { ...empty, coverage_total: coverageTotal, coverage_with_winner: 0 }
  }

  // 2. Pull latest + ~7-day-ago SERP snapshots for this brand × market.
  //    Window of 14 days covers the comparison; we pick the two anchor
  //    dates in JS to avoid two round-trips.
  const sinceDate = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10)
  const { data: snaps } = await db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, our_position, tier_keyword_id')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', pIds)
    .eq('market', market)
    .gte('snapshot_date', sinceDate)
    .order('snapshot_date', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allRows = (snaps ?? []) as any[]

  // Sprint COMPETITIVE.SCORER.4 — keep only snapshots whose kw is a cluster
  // winner. Match by tier_keyword_id (preferred) or fall back to
  // (product_tier_id × keyword) — covers older snapshots inserted before
  // tier_keyword_id was reliably populated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = allRows.filter((r: any) => {
    if (r.tier_keyword_id && winnerIdSet.has(String(r.tier_keyword_id))) return true
    const key = `${r.product_tier_id}|${String(r.keyword ?? '').toLowerCase()}`
    return winnerKeySet.has(key)
  })

  if (rows.length === 0) {
    return { ...empty, coverage_total: coverageTotal, coverage_with_winner: coverageWithWinner }
  }

  // Latest snapshot per (product × keyword): the most recent date present.
  // The "WoW prior" comparison: pick the latest snapshot strictly older
  // than (latestDate - 5 days). 5 days lets us flex around weekly cadence
  // without missing a comparison when the cron skips a day.
  const dates = Array.from(new Set(rows.map(r => String(r.snapshot_date)))).sort().reverse()
  const latestDate = dates[0]
  const latestMs   = new Date(latestDate).getTime()
  const priorCutoff = latestMs - 5 * 86_400_000   // cutoff: must be older than this
  const priorDate  = dates.find(d => new Date(d).getTime() < priorCutoff) ?? null

  type PerKw = { latest: number | null; prior: number | null }
  const perKw = new Map<string, PerKw>()
  for (const r of rows) {
    const key = `${r.product_tier_id}|${r.keyword}`
    const cur = perKw.get(key) ?? { latest: null, prior: null }
    const pos = r.our_position == null ? null : Number(r.our_position)
    if (r.snapshot_date === latestDate && cur.latest === null) cur.latest = pos
    if (priorDate && r.snapshot_date === priorDate && cur.prior === null) cur.prior = pos
    perKw.set(key, cur)
  }

  let posSum = 0, posCount = 0, top3 = 0, top10 = 0
  let posSumPrev = 0, posCountPrev = 0, top3Prev = 0, top10Prev = 0
  for (const v of perKw.values()) {
    if (v.latest != null) {
      posSum += v.latest; posCount++
      if (v.latest <= 3)  top3++
      if (v.latest <= 10) top10++
    }
    if (v.prior != null) {
      posSumPrev += v.prior; posCountPrev++
      if (v.prior <= 3)  top3Prev++
      if (v.prior <= 10) top10Prev++
    }
  }

  const avgPos     = posCount     > 0 ? +(posSum     / posCount).toFixed(1)     : null
  const avgPosPrev = posCountPrev > 0 ? +(posSumPrev / posCountPrev).toFixed(1) : null

  return {
    market,
    market_label: MARKET_LABELS[market],
    kw_count:     perKw.size,                    // now only counts winners
    avg_position:  avgPos,
    // Convention: positive delta = improvement (= prior - current; lower pos # is better)
    avg_pos_delta: (avgPos != null && avgPosPrev != null) ? +(avgPosPrev - avgPos).toFixed(1) : null,
    top3,
    top3_delta:    top3 - top3Prev,
    top10,
    top10_delta:   top10 - top10Prev,
    coverage_total:       coverageTotal,
    coverage_with_winner: coverageWithWinner,
  }
}

async function buildBrandTraffic(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  ownerId:  string,
  siteSlug: string,
): Promise<ClickKpi[]> {
  const emptyCells = (): ClickKpi[] => MARKETS.map(m => ({
    market: m, market_label: MARKET_LABELS[m], clicks: 0, clicks_pct: null, impressions: 0, imp_pct: null,
  }))

  // Resolve site_url for this brand from site_configs.
  const { data: cfg } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .maybeSingle()
  const siteUrl = cfg?.gsc_property as string | undefined
  if (!siteUrl) return emptyCells()

  // Pull this owner's GSC OAuth credentials so we can hit Search Analytics
  // with the country dimension. Without this, we'd fall back to summing
  // gsc_ranking_snapshots which has no country split.
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  if (!conn?.access_token || !conn?.refresh_token) {
    // Fallback: combined totals under Global cell, ID empty.
    return await buildTrafficFallback(db, siteUrl)
  }

  try {
    const { client: auth, newCredentials } = await getRefreshedClientFull(
      conn.access_token as string,
      conn.refresh_token as string,
      (conn.expires_at as string | null) ?? new Date(0).toISOString(),
    )
    // Best-effort token persist so the next call doesn't re-refresh.
    if (newCredentials) {
      void db
        .from('gsc_connections')
        .update({
          access_token: newCredentials.accessToken,
          expires_at:   newCredentials.expiresAt,
          updated_at:   new Date().toISOString(),
        })
        .eq('user_id', ownerId)
    }

    // Two windows: last 7 days (current) vs prior 7 days (prev).
    // GSC has ~3-day data freshness lag, so we offset by 3 days.
    const curStart  = getDateRange(WOW_DAYS + 3)
    const curEnd    = getDateRange(3)
    const prevStart = getDateRange(2 * WOW_DAYS + 3)
    const prevEnd   = getDateRange(WOW_DAYS + 4)

    const [curRows, prevRows] = await Promise.all([
      getSearchAnalytics(auth, siteUrl, curStart,  curEnd,  ['country'], 1000),
      getSearchAnalytics(auth, siteUrl, prevStart, prevEnd, ['country'], 1000),
    ])

    // Aggregate per country bucket: 'idn' → ID, everything else → Global.
    type Totals = { clicks: number; imp: number }
    const cur:  Record<'us' | 'id', Totals> = { us: { clicks: 0, imp: 0 }, id: { clicks: 0, imp: 0 } }
    const prev: Record<'us' | 'id', Totals> = { us: { clicks: 0, imp: 0 }, id: { clicks: 0, imp: 0 } }

    for (const r of curRows) {
      const country = (r.keys?.[0] ?? '').toLowerCase()
      const bucket  = country === 'idn' ? 'id' : 'us'
      cur[bucket].clicks += Number(r.clicks      ?? 0)
      cur[bucket].imp    += Number(r.impressions ?? 0)
    }
    for (const r of prevRows) {
      const country = (r.keys?.[0] ?? '').toLowerCase()
      const bucket  = country === 'idn' ? 'id' : 'us'
      prev[bucket].clicks += Number(r.clicks      ?? 0)
      prev[bucket].imp    += Number(r.impressions ?? 0)
    }

    const pct = (c: number, p: number): number | null => {
      if (p <= 0) return c > 0 ? 100 : null
      return +(((c - p) / p) * 100).toFixed(1)
    }

    return [
      { market: 'us', market_label: MARKET_LABELS.us, clicks: cur.us.clicks, clicks_pct: pct(cur.us.clicks, prev.us.clicks), impressions: cur.us.imp, imp_pct: pct(cur.us.imp, prev.us.imp) },
      { market: 'id', market_label: MARKET_LABELS.id, clicks: cur.id.clicks, clicks_pct: pct(cur.id.clicks, prev.id.clicks), impressions: cur.id.imp, imp_pct: pct(cur.id.imp, prev.id.imp) },
    ]
  } catch (err) {
    console.warn(`[friday-kpi] GSC country-split for ${siteSlug} failed, falling back:`, err)
    return await buildTrafficFallback(db, siteUrl)
  }
}

/**
 * Fallback: when GSC OAuth fails or isn't set up, sum gsc_ranking_snapshots
 * under "Global" and leave ID empty. Better than zero-everything.
 */
async function buildTrafficFallback(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any>,
  siteUrl: string,
): Promise<ClickKpi[]> {
  const today     = Date.now()
  const sinceCur  = new Date(today - WOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const sincePrev = new Date(today - 2 * WOW_DAYS * 86_400_000).toISOString().slice(0, 10)

  const { data: snaps } = await db
    .from('gsc_ranking_snapshots')
    .select('snapshot_date, clicks, impressions')
    .eq('site_url', siteUrl)
    .gte('snapshot_date', sincePrev)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (snaps ?? []) as any[]

  let curClicks = 0, curImp = 0, prevClicks = 0, prevImp = 0
  for (const r of rows) {
    const isCur = String(r.snapshot_date) >= sinceCur
    const c = Number(r.clicks      ?? 0)
    const i = Number(r.impressions ?? 0)
    if (isCur) { curClicks += c; curImp += i } else { prevClicks += c; prevImp += i }
  }
  const pct = (c: number, p: number): number | null => {
    if (p <= 0) return c > 0 ? 100 : null
    return +(((c - p) / p) * 100).toFixed(1)
  }
  return [
    { market: 'us', market_label: MARKET_LABELS.us, clicks: curClicks, clicks_pct: pct(curClicks, prevClicks), impressions: curImp, imp_pct: pct(curImp, prevImp) },
    { market: 'id', market_label: MARKET_LABELS.id, clicks: 0,         clicks_pct: null,                       impressions: 0,      imp_pct: null },
  ]
}

function weekLabel(now: Date = new Date()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return `Week ${isoWeek(d)} · ${d.toISOString().slice(0, 10)}`
}

function isoWeek(d: Date = new Date()): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

// ─── Slack PNG overview (short comment) ─────────────────────────────────────
//
// Sprint FRIDAY.KPI.SLACK-SIMPLIFY — When the digest is delivered as a PNG
// attachment, the image already contains all KPI tables. The Slack message
// only needs a brief 2-3 line overview as `initial_comment`. Use this helper
// instead of buildFridayKpiSlackBlocks() to avoid duplicating data.

export function buildPngOverviewComment(
  p: FridayKpiPayload,
  opts: { withPng?: boolean } = {},
): string {
  const withPng = opts.withPng !== false  // default true (PNG upload mode)

  const totalWinners = p.brands.reduce(
    (s, b) => s + b.serp.reduce((ss, m) => ss + m.kw_count, 0), 0,
  )

  const canon = p.canon_source === 'gsc' ? 'GSC' : 'DataForSEO'

  // Sprint FRIDAY.KPI.SLACK-PER-BRAND — per-brand clicks/impressions line.
  // Each brand gets its own 🔍 line with totals + WoW deltas (clicks-weighted).
  function fmtPct(pct: number | null): string {
    if (pct == null || Math.abs(pct) < 0.5) return 'flat'
    return pct > 0 ? `↑${pct.toFixed(0)}%` : `↓${Math.abs(pct).toFixed(0)}%`
  }
  function fmtCompact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
    return n.toLocaleString()
  }

  const brandLines = p.brands.map(b => {
    const totalClicks = b.traffic.reduce((s, t) => s + t.clicks, 0)
    const totalImps   = b.traffic.reduce((s, t) => s + t.impressions, 0)
    // clicks-weighted WoW for this brand
    let weightedDelta = 0, baseline = 0
    let weightedImpDelta = 0, impBaseline = 0
    for (const t of b.traffic) {
      if (t.clicks_pct != null && t.clicks > 0) {
        weightedDelta += t.clicks * t.clicks_pct
        baseline      += t.clicks
      }
      if (t.imp_pct != null && t.impressions > 0) {
        weightedImpDelta += t.impressions * t.imp_pct
        impBaseline      += t.impressions
      }
    }
    const clicksPct = baseline > 0 ? weightedDelta / baseline : null
    const impsPct   = impBaseline > 0 ? weightedImpDelta / impBaseline : null
    return `🔍 *${b.site_slug.toUpperCase()}* · ${fmtCompact(totalClicks)} clicks (${fmtPct(clicksPct)}) · ${fmtCompact(totalImps)} imps (${fmtPct(impsPct)})`
  })

  // Adapt last line to delivery mode. withPng=true → "see attached PNG".
  // withPng=false (webhook) → "open dashboard to view chart".
  const tail = withPng
    ? `📎 Full breakdown in attached PNG. Action Plan + competitive details inside.`
    : `🖼️  Visual breakdown + Action Plan available in the dashboard (link below).`

  return [
    `📊 *Weekly Report · ${p.week_label}*`,
    `Source ${canon} · ${totalWinners} competitive KWs tracked across ${p.brands.length} brand${p.brands.length === 1 ? '' : 's'}`,
    ...brandLines,
    tail,
  ].join('\n')
}

// ─── Slack block-kit builder (webhook fallback only) ────────────────────────

export function buildFridayKpiSlackBlocks(p: FridayKpiPayload): {
  text:   string
  blocks: Array<Record<string, unknown>>
} {
  const blocks: Array<Record<string, unknown>> = []

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `📊 Weekly Report · ${p.week_label}`, emoji: true },
  })

  // ── SERP rankings section ──
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*🥇 MOST COMPETITIVE KEYWORD RANKINGS*' },
  })

  // One block per brand — two-column layout (Global vs ID) using mrkdwn fields.
  for (const brand of p.brands) {
    const global = brand.serp.find(s => s.market === 'us') ?? null
    const id     = brand.serp.find(s => s.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}* · ${(global?.kw_count ?? 0) + (id?.kw_count ?? 0)} winning kws` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatSerpCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatSerpCell(id)}` },
      ],
    })

    // Sprint COMPETITIVE.SCORER.4 — coverage gap footer per brand.
    // Surfaces clusters (priority products) that don't have any winner
    // tracked yet, so the user knows where to run discovery next.
    const coverageLine = formatCoverageLine(global, id)
    if (coverageLine) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: coverageLine }],
      })
    }
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Most competitive = top 3 per cluster by competitive_score (<${p.methodology_url}|methodology>). Run discovery on gap clusters to seed missing winners._`,
    }],
  })

  // ── Traffic section ──
  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📈 SEO TRAFFIC — Clicks WoW (GSC)*' },
  })
  for (const brand of p.brands) {
    const global = brand.traffic.find(t => t.market === 'us') ?? null
    const id     = brand.traffic.find(t => t.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}*` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatClickCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatClickCell(id)}` },
      ],
    })
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: '*📈 SEO TRAFFIC — Impressions WoW (GSC)*' },
  })
  for (const brand of p.brands) {
    const global = brand.traffic.find(t => t.market === 'us') ?? null
    const id     = brand.traffic.find(t => t.market === 'id') ?? null
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${brand.site_slug.toUpperCase()}*` },
      fields: [
        { type: 'mrkdwn', text: `*🌐 Global*\n${formatImpCell(global)}` },
        { type: 'mrkdwn', text: `*🇮🇩 ID*\n${formatImpCell(id)}` },
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: '_GSC-verified · last 7 days vs prior 7 days (3-day freshness lag applied) · ID = country=idn, Global = all other countries._',
    }],
  })

  // ── Sprint FREYJA — AI Visibility section ──
  // Only render if we have data. Avoids empty section on fresh deploys.
  const hasAiData = p.ai_visibility?.some(a =>
    a.total_mentions > 0 || a.total_citations > 0 || a.total_cited > 0,
  )
  if (hasAiData) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*🔮 AI VISIBILITY (Freyja)*' },
    })
    for (const a of p.ai_visibility) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${a.site_slug.toUpperCase()}*` },
        fields: [
          {
            type: 'mrkdwn',
            text: `*Mentions*\n${formatK(a.total_mentions)} ${deltaPctArrow(a.mentions_wow_pct)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Citations*\n${formatK(a.total_citations)} ${deltaPctArrow(a.citations_wow_pct)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Cited Pages*\n${formatK(a.total_cited)} ${deltaPctArrow(a.cited_wow_pct)}`,
          },
          {
            type: 'mrkdwn',
            text: `*Top sources*\n${a.top_sources.slice(0, 3).map(s =>
              `${s.label}: ${formatK(s.citations)} ${deltaPctArrow(s.wow_pct)}`,
            ).join('\n') || '_none yet_'}`,
          },
        ],
      })
    }
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '_Across Bing AI + Semrush AI Visibility (ChatGPT, Gemini, AI Mode, AI Overview). Manual weekly imports until APIs stabilize._',
      }],
    })
  }

  // ── Sprint FORSETI.DIGEST — Community response section ──
  // Render only when at least one brand has activity. New tool may be unused
  // at first; skip the block silently when zero everywhere.
  const hasForsetiData = p.forseti?.some(f =>
    f.spotted_this_week > 0 || f.responded > 0 || f.sev4plus_pending > 0,
  )
  if (hasForsetiData) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*⚖ COMMUNITY RESPONSE (Forseti)*' },
    })
    for (const f of p.forseti) {
      const topCats = f.by_category.slice(0, 3)
        .map(c => `${c.category} (${c.count})`)
        .join(' · ') || '_none_'
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${f.site_slug.toUpperCase()}*` },
        fields: [
          { type: 'mrkdwn', text: `*Spotted*\n${f.spotted_this_week}` },
          { type: 'mrkdwn', text: `*Responded*\n${f.responded} (${f.response_rate_pct}%)` },
          { type: 'mrkdwn', text: `*Avg respond*\n${f.avg_response_time_h == null ? '—' : `${f.avg_response_time_h}h`}` },
          { type: 'mrkdwn', text: `*Sev-4+ pending*\n${f.sev4plus_pending > 0 ? `⚠ ${f.sev4plus_pending}` : '0'}` },
          { type: 'mrkdwn', text: `*Top categories*\n${topCats}` },
          { type: 'mrkdwn', text: `*Outcomes*\n${f.resolved_this_week} resolved · ${f.escalated_this_week} escalated` },
        ],
      })
    }
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: '_Reddit threads tracked via Forseti. Last 7 days, multi-subreddit. Tim membalas manual di Reddit + log di tool._',
      }],
    })
  }

  // ── Action buttons ──
  if (p.public_url || p.methodology_url || p.priority_url || p.ai_visibility_url || p.forseti_url) {
    blocks.push({
      type: 'actions',
      elements: [
        ...(p.public_url ? [{
          type: 'button',
          text: { type: 'plain_text', text: '📄 Public Report' },
          url:  p.public_url,
        }] : []),
        {
          type: 'button',
          text: { type: 'plain_text', text: '🎯 Methodology' },
          url:  p.methodology_url,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📊 Priority Products' },
          url:  p.priority_url,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔮 AI Visibility' },
          url:  p.ai_visibility_url,
        },
        ...(hasForsetiData ? [{
          type: 'button',
          text: { type: 'plain_text', text: '⚖ Forseti Queue' },
          url:  p.forseti_url,
        }] : []),
      ],
    })
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_Generated ${p.generated_at.slice(0, 16).replace('T', ' ')} UTC · Combined G2G + OG channel · notification_type=friday_kpi_`,
    }],
  })

  const totalKws = p.brands.reduce((s, b) => s + b.serp.reduce((ss, m) => ss + m.kw_count, 0), 0)
  const text = `📊 Friday KPI ${p.week_label} — ${totalKws} cluster winners across ${p.brands.length} brands`
  return { text, blocks }
}

function formatSerpCell(m: MarketKpi | null): string {
  if (!m || m.kw_count === 0) {
    if (m && m.coverage_total > 0 && m.coverage_with_winner === 0) return '_no winners scored yet — run /api/competitive/rescore_'
    return '_no tracked kws_'
  }
  return [
    `Avg #${m.avg_position?.toFixed(1) ?? '—'} ${deltaArrow(m.avg_pos_delta, true)}`,
    `Top 3: ${m.top3} ${signedCount(m.top3_delta)}`,
    `Top 10: ${m.top10} ${signedCount(m.top10_delta)}`,
  ].join('\n')
}

/**
 * Sprint COMPETITIVE.SCORER.4 — coverage gap line under each brand row.
 * Returns null when no gap signal worth surfacing (everything covered or
 * nothing tracked at all).
 *
 * Example outputs:
 *   "🌐 Global 18/22 clusters with winner · 🇮🇩 ID 0/4 — discovery pending"
 *   "🌐 Global 22/22 · 🇮🇩 ID 4/4 — full coverage"
 */
function formatCoverageLine(global: MarketKpi | null, id: MarketKpi | null): string | null {
  const parts: string[] = []
  for (const [icon, m] of [['🌐 Global', global], ['🇮🇩 ID', id]] as const) {
    if (!m || m.coverage_total === 0) continue
    const gap  = m.coverage_total - m.coverage_with_winner
    const flag = gap === 0 ? '✓' : gap >= 3 ? '⚠' : '·'
    parts.push(`${icon} ${m.coverage_with_winner}/${m.coverage_total} ${flag}`)
  }
  if (parts.length === 0) return null
  return `_Cluster coverage:_ ${parts.join('  •  ')}`
}

function formatClickCell(t: ClickKpi | null): string {
  if (!t) return '_n/a_'
  if (t.clicks === 0 && t.clicks_pct === null) return '_n/a_'
  return `${formatK(t.clicks)} ${deltaPctArrow(t.clicks_pct)}`
}

function formatImpCell(t: ClickKpi | null): string {
  if (!t) return '_n/a_'
  if (t.impressions === 0 && t.imp_pct === null) return '_n/a_'
  return `${formatK(t.impressions)} ${deltaPctArrow(t.imp_pct)}`
}

function deltaArrow(d: number | null, positiveIsGood: boolean): string {
  if (d == null) return ''
  if (Math.abs(d) < 0.05) return '·'
  const good = (d > 0) === positiveIsGood
  const arrow = d > 0 ? '↑' : '↓'
  const color = good ? '✅' : '⚠️'
  return `${arrow}${Math.abs(d).toFixed(1)} ${color}`
}

function signedCount(d: number): string {
  if (d === 0) return ''
  return d > 0 ? `(+${d})` : `(${d})`
}

function deltaPctArrow(d: number | null): string {
  if (d == null) return ''
  if (Math.abs(d) < 0.1) return '(flat)'
  const arrow = d > 0 ? '↑' : '↓'
  return `(${arrow}${Math.abs(d).toFixed(0)}%)`
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}
