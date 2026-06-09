// ─── Friday KPI — Boss View data layer ─────────────────────────────────────
// Build tag: 2026-06-08-sprint382-redeploy
//
// Sprint #361 WEEKLY.BOSS.VIEW — per-brand exec-friendly weekly snapshot:
//   1. Chart 1 — traffic bars (this wk vs last wk) + revenue lines per market
//      (US + ID), grouped by brand
//   2. Chart 2 — scatter rank movement for top 5 focus KW per brand, dots per
//      market × week (US-LW, US-TW, ID-LW, ID-TW)
//   3. AI Source slice — GA4 sessionSource filtered to AI assistant domains
//      (ChatGPT, Perplexity, Gemini, Claude, Copilot, Syntx) — traffic +
//      revenue + WoW delta per source
//
// Focus KW selection per brand = composite z-score of (clicks + revenue):
//   - Universe = cluster_winners (tier_keywords with is_cluster_winner=true)
//   - clicks  = GSC clicks per query, summed across US + ID
//   - revenue = GA4 totalRevenue of the top landing page that ranks for
//               the query (best-effort attribution; LP-level not KW-level)
//               Sprint #375 — switched from purchaseRevenue to totalRevenue
//               to match GA4 dashboard's default "Total revenue" column.
//   - z-score each metric independently, sum, top 5 by composite
//
// Window: same Thu→Wed pair as friday-kpi.ts so the boss view aligns with
// existing weekly digest numbers.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OAuth2Client } from 'google-auth-library'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'
import { normalizePath } from './friday-kpi-keyword-breakdown'

// ─── Window helper (Thu→Wed, current + previous) ────────────────────────────

export function bossViewWindows(now: Date = new Date()): {
  cur:  { start: string; end: string }
  prev: { start: string; end: string }
  /** Sprint #363 — historical range Jan 1 of current year → cur.end. The
   *  per-brand build pulls one GSC + one GA4 call covering this range and
   *  buckets into Thu→Wed weeks. */
  historical: { start: string; end: string }
  /** Thu→Wed week boundaries from historical.start → historical.end. Newest
   *  bucket is the same window as `cur`. */
  weeks: Array<{ start: string; end: string }>
} {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = today.getDay()
  const daysSinceCompletedWed = day === 3 ? 7 : (day + 4) % 7 || 7
  const curEnd = new Date(today)
  curEnd.setDate(today.getDate() - daysSinceCompletedWed)
  const curStart = new Date(curEnd)
  curStart.setDate(curEnd.getDate() - 6)
  const prevEnd = new Date(curStart)
  prevEnd.setDate(curStart.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevEnd.getDate() - 6)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  // Sprint #367 — historical range capped at LAST 13 WEEKS (was Jan→now /
  // year-to-date). YTD was the original spec but a 22-week GSC + GA4 fetch
  // tipped Vercel Hobby's 60s function cap consistently. 13 weeks ≈ one
  // quarter back; still gives a meaningful trend curve on the chart without
  // blowing the budget. UI label updated to "Last 13 Weeks" to reflect.
  const yearStart = new Date(curEnd.getFullYear(), 0, 1)
  let histStart = new Date(yearStart)
  const maxHistStart = new Date(curEnd)
  maxHistStart.setDate(curEnd.getDate() - 7 * 13)
  if (histStart < maxHistStart) histStart = maxHistStart

  // Walk Thu→Wed weeks backwards from curEnd until we hit histStart.
  const weeks: Array<{ start: string; end: string }> = []
  const cursor = new Date(curEnd)
  while (cursor >= histStart) {
    const wkEnd   = new Date(cursor)
    const wkStart = new Date(cursor)
    wkStart.setDate(cursor.getDate() - 6)
    if (wkStart >= histStart) {
      weeks.unshift({ start: iso(wkStart), end: iso(wkEnd) })
    }
    cursor.setDate(cursor.getDate() - 7)
  }

  return {
    cur:  { start: iso(curStart), end: iso(curEnd) },
    prev: { start: iso(prevStart), end: iso(prevEnd) },
    historical: { start: iso(histStart), end: iso(curEnd) },
    weeks,
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface BossViewMarketSlice {
  thisWeek: number
  lastWeek: number
  /** Positive = increase (good for traffic/revenue) */
  pct:      number | null
}

export interface BossViewFocusKeyword {
  keyword:    string
  /** Brand slug ('g2g' | 'offgamers'). Composite z-scores are computed
   *  per-brand (and for G2G, per-market). */
  brand:      string
  /** Market scope this KW was scored within. For G2G focus lists this is
   *  either 'us' or 'id' (separate lists). For OG it's 'all' (single list,
   *  US + ID combined). The renderer hides the irrelevant rank columns
   *  based on this field. */
  scope:      'us' | 'id' | 'all'
  /** Composite z-score (clicks_z + revenue_z). Higher = more important. */
  score:      number
  /** Current-week stats that drove the selection. Surfaced in the table so
   *  the reader sees "why is this KW on the list?" without guessing. The
   *  clicks/revenue figures are SCOPED — i.e. for a G2G US focus KW these
   *  are US-only metrics, not US+ID summed. */
  clicks:     number
  revenue:    number      // Sprint #363 — winner-take-all per LP, pro-rated none.
  topLandingPage: string  // normalized path
  /** Rank per (market × week). null = no tier_serp_snapshots row in that
   *  (market × Thu→Wed window). For G2G US focus KW, only `us` is populated
   *  (ID columns rendered as N/A); for G2G ID focus KW, only `id`. For OG
   *  focus KW both markets present. */
  us: { lastWeek: number | null; thisWeek: number | null }
  id: { lastWeek: number | null; thisWeek: number | null }
}

/**
 * Sprint #363 — historical timeline series per brand × market. One bucket
 * per ISO week from Jan 1 of the current year to the latest completed
 * Thu→Wed week. Used to render the 4 trend charts (G2G-US, G2G-ID, OG-US,
 * OG-ID) replacing the WoW grouped-bar chart.
 */
export interface HistoricalBucket {
  /** Week ending date (Wed), 'YYYY-MM-DD'. Used as X-axis tick. */
  weekEnd:  string
  clicks:   number
  /** Organic Search revenue from GA4 (filtered to channelGroup contains
   *  'organic'). 0 when GA4 not connected for this brand. */
  revenue:  number
}

export interface BossViewBrand {
  siteSlug: string
  siteName: string

  // Compact KPI strip (rendered above the per-brand-country historical
  // charts) — still shows WoW for the current week pair so the eye can
  // catch "what changed" at a glance, but no longer drives a separate chart.
  traffic: { us: BossViewMarketSlice; id: BossViewMarketSlice }
  revenue: { us: BossViewMarketSlice; id: BossViewMarketSlice }

  // Sprint #363 — 4 historical timelines, Jan 1 of current year → latest
  // completed Thu→Wed week. Keys: 'us' + 'id'. OG-ID timeline still rendered
  // even though OG's focus KW are unified — exec wants to see if ID traffic
  // is moving regardless of which KW are surfaced.
  historical: {
    us: HistoricalBucket[]
    id: HistoricalBucket[]
  }

  // Chart 2 data — top focus KW. Layout depends on brand:
  //   - G2G: focusKeywordsUs (5 KW scored within US) + focusKeywordsId (5
  //     KW scored within ID). Two separate lists because Galih's data shows
  //     US and ID focus KWs barely overlap.
  //   - OG: focusKeywords (5 KW scored on US+ID combined). Smaller portfolio,
  //     single list keeps it readable.
  focusKeywordsUs?: BossViewFocusKeyword[]   // G2G only
  focusKeywordsId?: BossViewFocusKeyword[]   // G2G only
  focusKeywords?:   BossViewFocusKeyword[]   // OG only

  // Diagnostics — surfaced in preview UI footer so reader can debug
  diagnostics: {
    cluster_winner_count:  number
    gsc_queries_fetched:   number
    ga4_rev_pages_fetched: number
    kw_with_ga4_match:     number
    historical_weeks:      number
    skip_reason?:          string
  }
}

export interface BossViewAiSource {
  domain:   string           // 'chatgpt.com', 'perplexity.ai', etc.
  label:    string           // 'ChatGPT', 'Perplexity', etc.
  users:    number           // current week
  sessions: number
  revenue:  number
  prevUsers:    number
  prevSessions: number
  prevRevenue:  number
}

export interface BossViewAiSlice {
  bySite: Record<string, {            // 'g2g' | 'offgamers'
    sources:        BossViewAiSource[]
    totalUsers:     number
    totalSessions:  number
    totalRevenue:   number
    prevTotalUsers:    number
    prevTotalSessions: number
    prevTotalRevenue:  number
    /** Set when GA4 OAuth missing or the property id can't be resolved — UI
     *  shows a "Not connected" badge and skips the panel for that brand. */
    skipReason?: string
  }>
}

export interface BossViewPayload {
  weekLabel:   string                 // e.g. "Week 23 · May 22-28"
  curStart:    string
  curEnd:      string
  prevStart:   string
  prevEnd:     string
  generatedAt: string                 // ISO

  brands:   BossViewBrand[]
  aiSource: BossViewAiSlice
}

// ─── Country matching (Sprint #375 / #376) ─────────────────────────────────
//
// GSC and GA4 don't agree on country format:
//   GSC `country` dim     → 3-letter ISO codes: 'usa', 'idn'
//   GA4 `country` dim     → display names: 'United States', 'Indonesia'
//   GA4 may also return   → 'US', 'ID' (2-letter ISO) on some properties
//
// Sprint #375 went too strict (only 'usa' / 'united states') and dropped
// significant US revenue ($654K → $201K). Sprint #376 broadens to accept
// every common variant for each market. Tag matching is case-insensitive +
// trimmed. Empty / '(not set)' / other-country rows are still dropped.

const US_TAGS = new Set(['usa', 'us', 'united states', 'united states of america'])
const ID_TAGS = new Set(['idn', 'id', 'indonesia'])

function classifyMarket(raw: string | null | undefined): 'us' | 'id' | null {
  if (!raw) return null
  const norm = raw.toLowerCase().trim()
  if (US_TAGS.has(norm)) return 'us'
  if (ID_TAGS.has(norm)) return 'id'
  return null
}

// ─── AI source whitelist ────────────────────────────────────────────────────
// Domains GA4 reports for AI-assistant referrals. Source: Galih's GA4
// "AI Source - Test" custom channel group screenshot (2026-06-04). We
// filter via dimensionFilter on sessionSource directly instead of depending
// on the channel group being deployed to both properties.
const AI_SOURCES: Array<{ domains: string[]; label: string }> = [
  { label: 'ChatGPT',     domains: ['chatgpt.com', 'chat.openai.com'] },
  { label: 'Perplexity',  domains: ['perplexity.ai', 'perplexity.oneaccessbd.com'] },
  { label: 'Gemini',      domains: ['gemini.google.com'] },
  { label: 'Claude',      domains: ['claude.ai'] },
  { label: 'Copilot',     domains: ['copilot.microsoft.com'] },
  { label: 'Other AI',    domains: ['syntx.ai'] },
]
const ALL_AI_DOMAINS = AI_SOURCES.flatMap(s => s.domains)

// (Domain → label resolution lives inline in buildAiSourceForBrand so it can
// share the AI_SOURCES table without exporting; kept here as a top-level
// concept for future callers.)

// ─── Composite z-score helper ───────────────────────────────────────────────

function zScores(values: number[]): number[] {
  if (values.length === 0) return []
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance)
  if (std === 0) return values.map(() => 0)   // all equal → all-zero z
  return values.map(v => (v - mean) / std)
}

function pctChange(cur: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((cur - prev) / prev) * 1000) / 10
}

function weekLabel(curStart: string, curEnd: string): string {
  const start = new Date(curStart)
  const end   = new Date(curEnd)
  const isoWeek = (() => {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()))
    const dayNr  = (d.getUTCDay() + 6) % 7
    d.setUTCDate(d.getUTCDate() - dayNr + 3)
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
    return 1 + Math.round(((d.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  })()
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `Week ${isoWeek} · ${fmt(start)}–${fmt(end)}`
}

// ─── Main: build the boss view payload ──────────────────────────────────────

export interface BuildBossViewOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>
  ownerId:   string
  siteSlugs: string[]
}

export async function buildBossView(opts: BuildBossViewOptions): Promise<BossViewPayload> {
  const { db, ownerId, siteSlugs } = opts
  const { cur, prev, historical, weeks } = bossViewWindows()

  // ── Shared OAuth resolver ─────────────────────────────────────────────────
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  let auth: OAuth2Client | null = null
  if (conn?.access_token && conn?.refresh_token) {
    try {
      // getRefreshedClient returns the OAuth2Client directly (vs the Full
      // variant which also surfaces newCredentials we don't need here).
      // expires_at can be null on legacy rows — pass epoch so the client
      // treats the token as expired and refreshes immediately.
      auth = await getRefreshedClient(
        conn.access_token  as string,
        conn.refresh_token as string,
        (conn.expires_at as string | null) ?? new Date(0).toISOString(),
      )
    } catch (e) {
      console.warn('[boss-view] OAuth refresh failed:', e)
    }
  }

  // ── Per-brand boss-view rows ──────────────────────────────────────────────
  // Sprint #364 — parallelize across brands (was serial, contributing to 60s
  // Vercel Hobby timeout). Each brand's build internally also parallelizes
  // its GSC + GA4 calls. Net effect: brand work overlaps + API calls within
  // each brand overlap, fitting comfortably under cap.
  const brands = await Promise.all(
    siteSlugs.map(slug => buildBrandBossView(
      db, ownerId, slug, auth, cur, prev, historical, weeks,
    )),
  )

  // ── AI source (parallel per brand) ────────────────────────────────────────
  const aiSource: BossViewAiSlice = { bySite: {} }
  await Promise.all(siteSlugs.map(async slug => {
    aiSource.bySite[slug] = await buildAiSourceForBrand(db, slug, auth, cur, prev)
  }))

  return {
    weekLabel:   weekLabel(cur.start, cur.end),
    curStart:    cur.start,
    curEnd:      cur.end,
    prevStart:   prev.start,
    prevEnd:     prev.end,
    generatedAt: new Date().toISOString(),
    brands,
    aiSource,
  }
}

// ─── Per-brand boss view (Sprint #363 V2) ──────────────────────────────────
//
// Changes vs V1:
//   - Historical timeline data (Jan → now) per brand × market
//   - Winner-take-all LP revenue attribution (top-clicking KW per LP gets
//     all the revenue; others on the same LP get $0)
//   - Min clicks threshold (MIN_CLICKS_FOR_FOCUS) to filter noise
//   - G2G focus KW split per market (US list + ID list, scored within
//     market); OG focus KW unified (US+ID combined)

const MIN_CLICKS_FOR_FOCUS = 10   // ignore KWs with <10 clicks/week in selection

async function buildBrandBossView(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:         SupabaseClient<any>,
  ownerId:    string,
  siteSlug:   string,
  auth:       OAuth2Client | null,
  cur:        { start: string; end: string },
  prev:       { start: string; end: string },
  historical: { start: string; end: string },
  weeks:      Array<{ start: string; end: string }>,
): Promise<BossViewBrand> {
  const emptyHist: HistoricalBucket[] = weeks.map(w => ({ weekEnd: w.end, clicks: 0, revenue: 0 }))
  const empty: BossViewBrand = {
    siteSlug,
    siteName: siteSlug === 'offgamers' ? 'OffGamers' : 'G2G',
    traffic: {
      us: { thisWeek: 0, lastWeek: 0, pct: null },
      id: { thisWeek: 0, lastWeek: 0, pct: null },
    },
    revenue: {
      us: { thisWeek: 0, lastWeek: 0, pct: null },
      id: { thisWeek: 0, lastWeek: 0, pct: null },
    },
    historical: { us: emptyHist, id: emptyHist },
    diagnostics: {
      cluster_winner_count:  0,
      gsc_queries_fetched:   0,
      ga4_rev_pages_fetched: 0,
      kw_with_ga4_match:     0,
      historical_weeks:      weeks.length,
    },
  }

  // ── site_configs ──────────────────────────────────────────────────────────
  const { data: cfg } = await db
    .from('site_configs')
    .select('slug, display_name, gsc_property, ga4_property_id')
    .eq('slug', siteSlug)
    .maybeSingle()
  if (!cfg) {
    empty.diagnostics.skip_reason = `site_configs row missing for ${siteSlug}`
    return empty
  }

  empty.siteName = (cfg.display_name as string | null) ?? empty.siteName
  const gscProperty   = (cfg.gsc_property as string | null) ?? null
  const ga4PropertyId = (cfg.ga4_property_id as string | null) ?? null

  // ── Cluster winners universe (for focus KW selection) ─────────────────────
  // tier_keywords with is_cluster_winner=true → join product_tiers for brand
  // scoping. The keyword strings are what we'll look up in GSC + tier_serp_snapshots.
  const { data: tierProducts } = await db
    .from('product_tiers')
    .select('id, market')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const productIds = ((tierProducts ?? []) as any[]).map(p => String(p.id))
  if (productIds.length === 0) {
    empty.diagnostics.skip_reason = `no product_tiers for brand ${siteSlug}`
    return empty
  }
  const { data: winnerRows } = await db
    .from('tier_keywords')
    .select('id, keyword, product_tier_id')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .eq('is_cluster_winner', true)
  type WinnerRow = { id: string; keyword: string; product_tier_id: string }
  const winners = (winnerRows ?? []) as WinnerRow[]
  empty.diagnostics.cluster_winner_count = winners.length
  if (winners.length === 0) {
    empty.diagnostics.skip_reason = 'no cluster_winners for brand'
    return empty
  }

  // Dedup keyword strings (same KW can appear under multiple product_tiers
  // when shared across clusters). Keep all tier_keyword_ids per keyword
  // string for the rank lookup below.
  const idsByKeyword = new Map<string, string[]>()    // keyword → tier_keyword_ids
  for (const w of winners) {
    const k = w.keyword.toLowerCase().trim()
    if (!idsByKeyword.has(k)) idsByKeyword.set(k, [])
    idsByKeyword.get(k)!.push(w.id)
  }
  const uniqueKeywords = Array.from(idsByKeyword.keys())

  // ── Historical timeline (Jan 1 of current year → cur.end) ────────────────
  // Sprint #364 — historical GSC + GA4 + current-week per-KW + LP revenue
  // all fire in parallel via Promise.all below. They share no data deps with
  // each other; only post-processing depends on uniqueKeywords (computed
  // synchronously above). Net wall time = max(individual call) instead of
  // sum, halving total brand-build duration.
  const histUs: HistoricalBucket[] = weeks.map(w => ({ weekEnd: w.end, clicks: 0, revenue: 0 }))
  const histId: HistoricalBucket[] = weeks.map(w => ({ weekEnd: w.end, clicks: 0, revenue: 0 }))

  // Helper: find the week index a given date falls into (or -1 if outside).
  const findWeekIdx = (date: string): number => {
    for (let i = 0; i < weeks.length; i++) {
      if (date >= weeks[i].start && date <= weeks[i].end) return i
    }
    return -1
  }

  // Sprint #386 — shared bucketer for the two per-market historical GA4
  // queries. Each call is country-pre-filtered at API level, so we don't
  // need to classifyMarket() here — every row goes to the passed bucket.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucketRevenueByDate = (resp: any, bucket: HistoricalBucket[]): void => {
    const rows = parseGA4Rows(resp)
    for (const r of rows) {
      // Defensive: dimensionFilter is CONTAINS 'Organic' (catches Organic
      // Search/Social/Video/Shopping). If GA4 ever changes its channel
      // grouping, drop the row instead of silently inflating bucket totals.
      if (!(r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic')) continue
      const raw = String(r.date ?? '')
      // GA4 date dim returns YYYYMMDD — normalize to YYYY-MM-DD
      const date = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw
      const rev  = parseFloat(r.totalRevenue ?? '0')
      const idx  = findWeekIdx(date)
      if (idx < 0) continue
      bucket[idx].revenue += rev
    }
  }

  // Per-(KW × market) clicks bucket
  const clicksByKwMarket = new Map<string, { us: number; id: number }>()
  // Per-(KW × market) top landing page bucket
  type LpBucket = { path: string; clicks: number }
  const topPageByKwMarket = new Map<string, { us?: LpBucket; id?: LpBucket }>()
  // Per-(LP × market) GA4 revenue bucket
  const revenueByPathMarket = new Map<string, { us: number; id: number }>()

  // Fire 5 independent calls in parallel. Each call's parse/bucket logic runs
  // inside the call's .then() so the outer Promise.all just waits.
  await Promise.all([
    // 1. Historical GSC (full Jan→now window, day-level)
    auth && gscProperty
      ? getSearchAnalytics(auth, gscProperty, historical.start, historical.end, ['date', 'country'], 25000)
          .then(rows => {
            for (const r of rows) {
              const date    = String(r.keys?.[0] ?? '')
              const country = String(r.keys?.[1] ?? '')
              const clicks  = Number(r.clicks ?? 0)
              const idx = findWeekIdx(date)
              if (idx < 0) continue
              // Sprint #376 — accept all common country variants (see
              // classifyMarket). Sprint #375's strict 'usa'/'idn'-only check
              // dropped legit data.
              const mkt = classifyMarket(country)
              if      (mkt === 'us') histUs[idx].clicks += clicks
              else if (mkt === 'id') histId[idx].clicks += clicks
            }
          })
          .catch(e => console.warn(`[boss-view ${siteSlug}] historical GSC failed:`, e))
      : Promise.resolve(),

    // 2. Historical GA4 (full window, organic only)
    // Sprint #377 — added dimensionFilter to dodge GA4 sampling. Without
    //              it, dim=[date,country,channelGroup] over 13 weeks generates
    //              ~200K row permutations and GA4 silently samples to ~25%.
    // Sprint #381 — Tried channel-only filter; still sampled (~54K rows).
    // Sprint #382 — Country variants + caseSensitive: false; identical
    //              output → GA4 only emits "United States" anyway, variants
    //              were never the bottleneck.
    // Sprint #383 — Frustration hardcode of dashboard values (removed in #386).
    // Sprint #386 — ROOT FIX. Split into TWO parallel queries (US + ID),
    //              drop `country` from dimensions (keep in filter only),
    //              and drop high-cardinality `country` dim entirely.
    //              Per-query: dim=[date, channel] → 91 days × ~3 channel
    //              variants = ~273 rows. Way under sampling threshold for
    //              any GA4 property tier. The GA4 Traffic Acquisition
    //              standard report works the same way (no `date` × per-country
    //              breakdown) which is why it shows unsampled $713K.
    auth && ga4PropertyId
      ? Promise.all([
          // ── US slice ────────────────────────────────────────────────
          getGA4Report(auth, ga4PropertyId, historical.start, historical.end,
              ['date', 'sessionDefaultChannelGroup'], ['totalRevenue'], 5000,
              {
                andGroup: { expressions: [
                  { filter: { fieldName: 'country',
                    inListFilter: {
                      values: ['United States', 'US', 'USA', 'United States of America'],
                      caseSensitive: false,
                    } } },
                  { filter: { fieldName: 'sessionDefaultChannelGroup',
                    stringFilter: { matchType: 'CONTAINS', value: 'Organic', caseSensitive: false } } },
                ] },
              })
            .then(resp => bucketRevenueByDate(resp, histUs))
            .catch(e => console.warn(`[boss-view ${siteSlug}] historical GA4 US failed:`, e)),
          // ── ID slice ────────────────────────────────────────────────
          getGA4Report(auth, ga4PropertyId, historical.start, historical.end,
              ['date', 'sessionDefaultChannelGroup'], ['totalRevenue'], 5000,
              {
                andGroup: { expressions: [
                  { filter: { fieldName: 'country',
                    inListFilter: {
                      values: ['Indonesia', 'ID', 'IDN'],
                      caseSensitive: false,
                    } } },
                  { filter: { fieldName: 'sessionDefaultChannelGroup',
                    stringFilter: { matchType: 'CONTAINS', value: 'Organic', caseSensitive: false } } },
                ] },
              })
            .then(resp => bucketRevenueByDate(resp, histId))
            .catch(e => console.warn(`[boss-view ${siteSlug}] historical GA4 ID failed:`, e)),
        ]).then(() => { /* collapse to void for Promise.all parent */ })
      : Promise.resolve(),

    // 3. Per-(KW × market) GSC clicks for current week
    auth && gscProperty
      ? getSearchAnalytics(auth, gscProperty, cur.start, cur.end, ['query', 'country'], 25000)
          .then(rows => {
            empty.diagnostics.gsc_queries_fetched = rows.length
            const winnerSet = new Set(uniqueKeywords)
            for (const r of rows) {
              const q = String(r.keys?.[0] ?? '').toLowerCase().trim()
              if (!winnerSet.has(q)) continue
              const country = String(r.keys?.[1] ?? '')
              const clicks  = Number(r.clicks ?? 0)
              const bucket  = clicksByKwMarket.get(q) ?? { us: 0, id: 0 }
              // Sprint #376 — fuzzy country match
              const mkt = classifyMarket(country)
              if      (mkt === 'us') bucket.us += clicks
              else if (mkt === 'id') bucket.id += clicks
              else continue
              clicksByKwMarket.set(q, bucket)
            }
          })
          .catch(e => console.warn(`[boss-view ${siteSlug}] GSC per-query failed:`, e))
      : Promise.resolve(),

    // 4. Per-(KW × market) top landing page for current week
    auth && gscProperty
      ? getSearchAnalytics(auth, gscProperty, cur.start, cur.end, ['page', 'query', 'country'], 25000)
          .then(rows => {
            const winnerSet = new Set(uniqueKeywords)
            for (const r of rows) {
              const page    = String(r.keys?.[0] ?? '')
              const q       = String(r.keys?.[1] ?? '').toLowerCase().trim()
              const country = String(r.keys?.[2] ?? '')
              if (!winnerSet.has(q)) continue
              // Sprint #376 — fuzzy country match
              const mkt = classifyMarket(country)
              if (!mkt) continue
              const clicks = Number(r.clicks ?? 0)
              const isId   = mkt === 'id'
              const path   = normalizePath(page)
              const entry  = topPageByKwMarket.get(q) ?? {}
              const slot   = isId ? entry.id : entry.us
              if (!slot || clicks > slot.clicks) {
                if (isId) entry.id = { path, clicks }
                else      entry.us = { path, clicks }
                topPageByKwMarket.set(q, entry)
              }
            }
          })
          .catch(e => console.warn(`[boss-view ${siteSlug}] GSC page×query×country failed:`, e))
      : Promise.resolve(),

    // 5. GA4 LP revenue (current week, organic only)
    // Sprint #382 — country variants + channel filter (see historical note).
    auth && ga4PropertyId
      ? getGA4Report(auth, ga4PropertyId, cur.start, cur.end,
          ['landingPage', 'country', 'sessionDefaultChannelGroup'], ['totalRevenue'], 10000,
          {
            andGroup: { expressions: [
              { filter: { fieldName: 'country',
                inListFilter: {
                  values: ['United States', 'US', 'USA', 'United States of America',
                           'Indonesia', 'ID', 'IDN'],
                  caseSensitive: false,
                } } },
              { filter: { fieldName: 'sessionDefaultChannelGroup',
                stringFilter: { matchType: 'CONTAINS', value: 'Organic', caseSensitive: false } } },
            ] },
          })
          .then(resp => {
            // Sprint #375 — switched to totalRevenue (was purchaseRevenue).
            const rows = parseGA4Rows(resp)
            empty.diagnostics.ga4_rev_pages_fetched = rows.length
            for (const r of rows) {
              if (!(r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic')) continue
              const path    = normalizePath(r.landingPage ?? '')
              const country = r.country ?? ''
              const rev     = parseFloat(r.totalRevenue ?? '0')
              if (!path) continue
              const bucket = revenueByPathMarket.get(path) ?? { us: 0, id: 0 }
              // Sprint #376 — fuzzy country match
              const mkt = classifyMarket(country)
              if      (mkt === 'us') bucket.us += rev
              else if (mkt === 'id') bucket.id += rev
              else continue
              revenueByPathMarket.set(path, bucket)
            }
          })
          .catch(e => console.warn(`[boss-view ${siteSlug}] GA4 LP revenue failed:`, e))
      : Promise.resolve(),
  ])

  // KPI strip values (this wk + last wk) come straight from the historical
  // buckets — last 2 entries — so we don't duplicate API calls.
  // (Sprint #383 hardcode override removed in #386 — root sampling cause
  // fixed by splitting historical query into per-market calls.)
  const lastIdx = weeks.length - 1
  const prevIdx = weeks.length - 2
  const trafficUsCur  = lastIdx >= 0 ? histUs[lastIdx].clicks : 0
  const trafficIdCur  = lastIdx >= 0 ? histId[lastIdx].clicks : 0
  const trafficUsPrev = prevIdx >= 0 ? histUs[prevIdx].clicks : 0
  const trafficIdPrev = prevIdx >= 0 ? histId[prevIdx].clicks : 0
  const revUsCur  = lastIdx >= 0 ? histUs[lastIdx].revenue : 0
  const revIdCur  = lastIdx >= 0 ? histId[lastIdx].revenue : 0
  const revUsPrev = prevIdx >= 0 ? histUs[prevIdx].revenue : 0
  const revIdPrev = prevIdx >= 0 ? histId[prevIdx].revenue : 0

  // (clicksByKwMarket, topPageByKwMarket, revenueByPathMarket are all
  // populated by the parallel Promise.all block above. Just declare the
  // maps before they're used — actual data already in by the time we get
  // here.)

  // ── Focus KW selection: per-scope, winner-take-all attribution ───────────
  //
  // For each scope ('us', 'id', or 'all'):
  //   1. Collect candidate KWs with their scoped clicks + top LP within scope
  //   2. Group candidates by LP. For each LP, only the top-clicking KW gets
  //      the LP's revenue. Other KWs sharing the LP get $0 (winner-take-all).
  //   3. Filter to KWs with ≥ MIN_CLICKS_FOR_FOCUS clicks in scope.
  //   4. Z-score normalize clicks + revenue, sum, top 5 by composite.
  //
  // selectFocus also captures the top-clicking LP per KW so the table can
  // display "Why this KW?" — that LP is shown beneath the keyword.
  function selectFocus(scope: 'us' | 'id' | 'all'): BossViewFocusKeyword[] {
    type Cand = { keyword: string; clicks: number; lp: string; revenue: number }
    // 1. Collect raw candidates
    const raw: Cand[] = []
    for (const kw of uniqueKeywords) {
      const c = clicksByKwMarket.get(kw)
      if (!c) continue
      const lpEntry = topPageByKwMarket.get(kw)
      let clicks = 0, lp = ''
      if (scope === 'us') {
        clicks = c.us
        lp     = lpEntry?.us?.path ?? ''
      } else if (scope === 'id') {
        clicks = c.id
        lp     = lpEntry?.id?.path ?? ''
      } else {
        clicks = c.us + c.id
        // For 'all', prefer the LP with more clicks
        const usLp = lpEntry?.us
        const idLp = lpEntry?.id
        lp = !usLp ? (idLp?.path ?? '') :
             !idLp ? usLp.path :
             usLp.clicks >= idLp.clicks ? usLp.path : idLp.path
      }
      if (clicks < MIN_CLICKS_FOR_FOCUS) continue
      raw.push({ keyword: kw, clicks, lp, revenue: 0 })
    }
    if (raw.length === 0) return []

    // 2. Winner-take-all by LP within scope
    // For each LP, find the KW with the highest clicks. That KW gets the
    // LP's scoped revenue; all other KWs sharing the LP get $0.
    const byLp = new Map<string, Cand[]>()
    for (const c of raw) {
      if (!c.lp) continue   // KW without resolved LP — gets 0 revenue
      const list = byLp.get(c.lp) ?? []
      list.push(c)
      byLp.set(c.lp, list)
    }
    for (const [lp, candList] of byLp.entries()) {
      const lpRevByMkt = revenueByPathMarket.get(lp)
      if (!lpRevByMkt) continue
      const lpRev = scope === 'us' ? lpRevByMkt.us :
                    scope === 'id' ? lpRevByMkt.id :
                                     lpRevByMkt.us + lpRevByMkt.id
      if (lpRev <= 0) continue
      // Winner = top-clicking KW for this LP. Tie-break by keyword string
      // alphabetical for determinism.
      candList.sort((a, b) => b.clicks - a.clicks || a.keyword.localeCompare(b.keyword))
      candList[0].revenue = lpRev
    }

    // 3 + 4. Composite z-score + top 5
    const clicksZ = zScores(raw.map(c => c.clicks))
    const revZ    = zScores(raw.map(c => c.revenue))
    const scored = raw
      .map((c, i) => ({ ...c, score: clicksZ[i] + revZ[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    // Map scoped tier_keyword_ids — for G2G we filter to product_tiers.market
    // matching scope; for OG we accept any.
    return scored.map(s => ({
      keyword:        s.keyword,
      brand:          siteSlug,
      scope,
      score:          +s.score.toFixed(3),
      clicks:         s.clicks,
      revenue:        +s.revenue.toFixed(2),
      topLandingPage: s.lp,
      us: { lastWeek: null, thisWeek: null },
      id: { lastWeek: null, thisWeek: null },
    }))
  }

  // Per-brand focus list selection
  let focusKeywordsUs: BossViewFocusKeyword[] | undefined
  let focusKeywordsId: BossViewFocusKeyword[] | undefined
  let focusKeywords:   BossViewFocusKeyword[] | undefined
  if (siteSlug === 'g2g') {
    focusKeywordsUs = selectFocus('us')
    focusKeywordsId = selectFocus('id')
  } else {
    focusKeywords = selectFocus('all')
  }

  const allFocusKws = [
    ...(focusKeywordsUs ?? []),
    ...(focusKeywordsId ?? []),
    ...(focusKeywords   ?? []),
  ]
  empty.diagnostics.kw_with_ga4_match = allFocusKws.filter(k => k.revenue > 0).length

  // ── Rank lookup for all focus KWs across all scopes ──────────────────────
  if (allFocusKws.length > 0) {
    const wantedKeywords = new Set(allFocusKws.map(k => k.keyword))
    const focusKwIds: string[] = []
    const idToKeyword = new Map<string, string>()
    for (const kw of wantedKeywords) {
      const ids = idsByKeyword.get(kw) ?? []
      for (const id of ids) {
        focusKwIds.push(id)
        idToKeyword.set(id, kw)
      }
    }

    type SnapRow = {
      tier_keyword_id: string | null
      market:          string
      snapshot_date:   string
      our_position:    number | null
    }
    const snaps: SnapRow[] = []
    if (focusKwIds.length > 0) {
      const { data } = await db
        .from('tier_serp_snapshots')
        .select('tier_keyword_id, market, snapshot_date, our_position')
        .eq('owner_user_id', ownerId)
        .in('tier_keyword_id', focusKwIds)
        .gte('snapshot_date', prev.start)
        .lte('snapshot_date', cur.end)
      snaps.push(...((data ?? []) as SnapRow[]))
    }

    type RankCell = { date: string; pos: number | null }
    const ranks = new Map<string, RankCell>()
    for (const r of snaps) {
      if (!r.tier_keyword_id) continue
      const kw = idToKeyword.get(String(r.tier_keyword_id))
      if (!kw) continue
      const market = r.market === 'id' ? 'id' : 'us'
      const win    = r.snapshot_date >= cur.start && r.snapshot_date <= cur.end ? 'cur' :
                     r.snapshot_date >= prev.start && r.snapshot_date <= prev.end ? 'prev' : null
      if (!win) continue
      const k = `${kw}|${market}|${win}`
      const prevCell = ranks.get(k)
      if (!prevCell || r.snapshot_date > prevCell.date) {
        ranks.set(k, { date: r.snapshot_date, pos: r.our_position })
      }
    }

    const enrich = (kw: BossViewFocusKeyword) => {
      kw.us = {
        lastWeek: ranks.get(`${kw.keyword}|us|prev`)?.pos ?? null,
        thisWeek: ranks.get(`${kw.keyword}|us|cur`)?.pos  ?? null,
      }
      kw.id = {
        lastWeek: ranks.get(`${kw.keyword}|id|prev`)?.pos ?? null,
        thisWeek: ranks.get(`${kw.keyword}|id|cur`)?.pos  ?? null,
      }
    }
    focusKeywordsUs?.forEach(enrich)
    focusKeywordsId?.forEach(enrich)
    focusKeywords?.forEach(enrich)
  }

  if (allFocusKws.length === 0) {
    empty.diagnostics.skip_reason = `no cluster_winners cleared ${MIN_CLICKS_FOR_FOCUS}-clicks threshold`
  }

  return {
    siteSlug,
    siteName: empty.siteName,
    traffic: {
      us: { thisWeek: trafficUsCur, lastWeek: trafficUsPrev, pct: pctChange(trafficUsCur, trafficUsPrev) },
      id: { thisWeek: trafficIdCur, lastWeek: trafficIdPrev, pct: pctChange(trafficIdCur, trafficIdPrev) },
    },
    revenue: {
      us: { thisWeek: revUsCur, lastWeek: revUsPrev, pct: pctChange(revUsCur, revUsPrev) },
      id: { thisWeek: revIdCur, lastWeek: revIdPrev, pct: pctChange(revIdCur, revIdPrev) },
    },
    historical: { us: histUs, id: histId },
    focusKeywordsUs,
    focusKeywordsId,
    focusKeywords,
    diagnostics: empty.diagnostics,
  }
}

// ─── AI source slice per brand ──────────────────────────────────────────────

async function buildAiSourceForBrand(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>,
  siteSlug: string,
  auth:     OAuth2Client | null,
  cur:      { start: string; end: string },
  prev:     { start: string; end: string },
): Promise<BossViewAiSlice['bySite'][string]> {
  const empty = {
    sources: [] as BossViewAiSource[],
    totalUsers:     0,
    totalSessions:  0,
    totalRevenue:   0,
    prevTotalUsers:    0,
    prevTotalSessions: 0,
    prevTotalRevenue:  0,
  }

  const { data: cfg } = await db
    .from('site_configs')
    .select('ga4_property_id')
    .eq('slug', siteSlug)
    .maybeSingle()
  const ga4PropertyId = (cfg?.ga4_property_id as string | null) ?? null
  if (!auth || !ga4PropertyId) {
    return { ...empty, skipReason: 'GA4 not connected for this brand' }
  }

  try {
    const [curResp, prevResp] = await Promise.all([
      // Sprint #375 — switched purchaseRevenue → totalRevenue to match GA4
      // dashboard's "Total revenue" column. Same change as the brand-level
      // historical revenue queries above.
      getGA4Report(auth, ga4PropertyId, cur.start,  cur.end,
        ['sessionSource'], ['totalUsers', 'sessions', 'totalRevenue'], 200),
      getGA4Report(auth, ga4PropertyId, prev.start, prev.end,
        ['sessionSource'], ['totalUsers', 'sessions', 'totalRevenue'], 200),
    ])
    const curRows  = parseGA4Rows(curResp)
    const prevRows = parseGA4Rows(prevResp)

    // Bucket per AI source label (group same-label domains, e.g. chatgpt.com
    // and chat.openai.com both → 'ChatGPT'). Domain match is case-insensitive
    // and tolerates www. / regional subdomains.
    type Bucket = { users: number; sessions: number; revenue: number }
    const labelMatchesDomain = (source: string): string | null => {
      const lower = source.toLowerCase().replace(/^www\./, '')
      for (const s of AI_SOURCES) {
        if (s.domains.some(d => lower === d || lower.endsWith('.' + d))) return s.label
      }
      return null
    }
    const accumulate = (rows: ReturnType<typeof parseGA4Rows>) => {
      const buckets = new Map<string, Bucket>()
      let totUsers = 0, totSessions = 0, totRevenue = 0
      for (const r of rows) {
        const src   = String(r.sessionSource ?? '')
        const label = labelMatchesDomain(src)
        if (!label) continue
        const u = Number(r.totalUsers ?? 0)
        const s = Number(r.sessions ?? 0)
        const v = parseFloat(r.totalRevenue ?? '0')
        const bucket = buckets.get(label) ?? { users: 0, sessions: 0, revenue: 0 }
        bucket.users    += u
        bucket.sessions += s
        bucket.revenue  += v
        buckets.set(label, bucket)
        totUsers    += u
        totSessions += s
        totRevenue  += v
      }
      return { buckets, totUsers, totSessions, totRevenue }
    }

    const curAcc  = accumulate(curRows)
    const prevAcc = accumulate(prevRows)

    // Build merged source list (every label that appears in either window)
    const allLabels = new Set<string>([
      ...Array.from(curAcc.buckets.keys()),
      ...Array.from(prevAcc.buckets.keys()),
    ])
    const sources: BossViewAiSource[] = []
    for (const label of allLabels) {
      const c = curAcc.buckets.get(label)  ?? { users: 0, sessions: 0, revenue: 0 }
      const p = prevAcc.buckets.get(label) ?? { users: 0, sessions: 0, revenue: 0 }
      sources.push({
        // Domain field shows the primary domain for the label group (display
        // hint; the actual filter joined multiple).
        domain:   AI_SOURCES.find(s => s.label === label)?.domains[0] ?? label.toLowerCase(),
        label,
        users:        c.users,
        sessions:     c.sessions,
        revenue:      +c.revenue.toFixed(2),
        prevUsers:    p.users,
        prevSessions: p.sessions,
        prevRevenue:  +p.revenue.toFixed(2),
      })
    }
    sources.sort((a, b) => b.users - a.users)

    return {
      sources,
      totalUsers:        curAcc.totUsers,
      totalSessions:     curAcc.totSessions,
      totalRevenue:      +curAcc.totRevenue.toFixed(2),
      prevTotalUsers:    prevAcc.totUsers,
      prevTotalSessions: prevAcc.totSessions,
      prevTotalRevenue:  +prevAcc.totRevenue.toFixed(2),
    }
  } catch (e) {
    console.warn(`[boss-view ${siteSlug}] GA4 AI source failed:`, e)
    return { ...empty, skipReason: `GA4 query failed: ${e instanceof Error ? e.message : 'unknown'}` }
  }
}

// Re-export so callers don't have to import from the keyword-breakdown module
export { ALL_AI_DOMAINS, AI_SOURCES }
