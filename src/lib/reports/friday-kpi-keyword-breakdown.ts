// Sprint FRIDAY.KPI.KW-BREAKDOWN.1 (337) —
// Pull-and-join helper for the Friday KPI "Keyword Breakdown" sub-page.
//
// For one (owner × site × Thu→Wed week):
//   1. GA4 → getGA4RevenueByLandingPage()
//        per landingPage: sessions, purchaseRevenue, transactions
//        filtered to sessionDefaultChannelGroup='Organic Search'
//   2. GSC → getSearchAnalytics(dim=['page','query'])
//        per (page × query): clicks, impressions, position
//   3. Join on page path (path-normalized to strip locale prefixes / trailing
//      slashes / query strings) → one row per landing page with:
//        sessions, transactions, revenue, top 5 queries (sorted by clicks)
//   4. Sort by sessions desc (default), cap at 200 rows.
//
// Output cached as JSONB in friday_kpi_keyword_breakdown table so the page
// can render without re-hitting GA4 + GSC every load. Refresh = manual.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { parseGA4Rows } from '@/lib/ga4/client'

export interface KeywordBreakdownQuery {
  query:       string
  rank:        number | null   // GSC position (avg over window)
  clicks:      number
  impressions: number
}

export interface KeywordBreakdownMarketSlice {
  sessions:     number
  transactions: number
  revenue:      number
  top_queries:  KeywordBreakdownQuery[]
}

export interface KeywordBreakdownRow {
  page:         string                       // normalized path, e.g. '/categories/blade-and-soul-neo'
  category:     string | null                // joined from product_tiers.category, null = unmatched
  // Aggregate (US + ID combined)
  sessions:     number
  transactions: number
  revenue:      number
  top_queries:  KeywordBreakdownQuery[]      // up to 5, sorted by clicks desc
  // Sprint FRIDAY.KPI.KW.FILTERS (340) — per-market slices for the
  // server-side US/ID filter. UI swaps which slice it renders based on the
  // market toggle. Each slice is independently top-N'd to keep payload
  // small but useful per-market.
  us: KeywordBreakdownMarketSlice
  id: KeywordBreakdownMarketSlice
}

export interface KeywordBreakdownPayload {
  site_slug:     string
  week_start:    string         // 'YYYY-MM-DD'
  week_end:      string         // 'YYYY-MM-DD'
  generated_at:  string         // ISO8601
  rows:          KeywordBreakdownRow[]
  /** Diagnostic counters surfaced in the UI footer so the user knows what
   *  loaded vs what failed (e.g. "GA4 not connected") without diving in
   *  to logs. */
  diagnostics: {
    ga4_rows_fetched:    number
    gsc_rows_fetched:    number
    matched_pages:       number
    ga4_only_pages:      number
    gsc_only_pages:      number
    ga4_error?:          string
    gsc_error?:          string
  }
}

/**
 * Same Thu→Wed window math used by buildFridayKpi(). Replicated here so
 * we don't have to export the private helper from friday-kpi.ts.
 */
function getThuWedWindow(now: Date = new Date()): { weekStart: string; weekEnd: string } {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = today.getDay()
  const daysSinceCompletedWed = day === 3 ? 7 : (day + 4) % 7 || 7
  const end = new Date(today)
  end.setDate(today.getDate() - daysSinceCompletedWed)
  const start = new Date(end)
  start.setDate(end.getDate() - 6)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { weekStart: iso(start), weekEnd: iso(end) }
}

/**
 * Normalize page path for joining GA4 ↔ GSC rows.
 *
 * GA4 `landingPage` example:  '/en/categories/blade-and-soul-neo/?utm=foo'
 * GSC `page` example:         'https://www.g2g.com/categories/blade-and-soul-neo'
 *
 * Strategy:
 *   1. If full URL → drop scheme + host, keep path + (no) querystring
 *   2. Strip leading locale prefix (/en, /id, /ms, etc.) — G2G uses these
 *      while GA4 attribution often coalesces to canonical
 *   3. Drop trailing slash (except for '/')
 *   4. Lowercase
 */
const LOCALE_PREFIXES = new Set([
  'en', 'id', 'ms', 'th', 'vi', 'zh', 'pt', 'ru', 'es', 'fr', 'de', 'jp', 'ko', 'tr', 'ar',
])
export function normalizePath(input: string): string {
  if (!input) return ''
  let p = String(input)
  // 1. Strip scheme + host
  try {
    if (/^https?:\/\//i.test(p)) {
      const u = new URL(p)
      p = u.pathname + (u.search || '')
    }
  } catch {/* keep raw */}
  // Strip ?query and #anchor
  p = p.split('?')[0].split('#')[0]
  // 2. Strip leading locale (single segment after leading slash)
  const m = p.match(/^\/([a-z]{2})(\/|$)/i)
  if (m && LOCALE_PREFIXES.has(m[1].toLowerCase())) {
    p = '/' + p.slice(m[0].length)
    if (p.startsWith('//')) p = p.slice(1)
  }
  // 3. Trailing slash (but keep root)
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  // 4. Lowercase
  return p.toLowerCase()
}

interface BuildOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any>
  ownerId:  string
  siteSlug: string
  /** Optional override; defaults to most-recently-completed Thu→Wed */
  weekStart?: string
}

/**
 * Build a fresh keyword breakdown for one (owner × site × week). Hits GA4 +
 * GSC live. Caller is responsible for caching the result in
 * friday_kpi_keyword_breakdown if desired.
 */
export async function buildKeywordBreakdown(opts: BuildOptions): Promise<KeywordBreakdownPayload> {
  const { db, ownerId, siteSlug } = opts
  const { weekStart, weekEnd } = opts.weekStart
    ? { weekStart: opts.weekStart, weekEnd: addDays(opts.weekStart, 6) }
    : getThuWedWindow()

  const diagnostics: KeywordBreakdownPayload['diagnostics'] = {
    ga4_rows_fetched: 0,
    gsc_rows_fetched: 0,
    matched_pages:    0,
    ga4_only_pages:   0,
    gsc_only_pages:   0,
  }

  // ── Resolve site_configs row (GA4 property id + GSC property URL) ──────
  const { data: cfg } = await db
    .from('site_configs')
    .select('slug, gsc_property, ga4_property_id')
    .eq('slug', siteSlug)
    .maybeSingle()
  const ga4PropertyId = (cfg?.ga4_property_id ?? process.env.GA4_PROPERTY_ID ?? null) as string | null
  const gscProperty   = (cfg?.gsc_property as string | null) ?? null

  // ── Load category map from product_tiers (page path → category) ────────
  // Sprint FRIDAY.KPI.KW.FILTERS (340) — categories come from the curated
  // product_tiers table. We resolve them by exact-match on normalized URL.
  // Pages that don't match any tier (blog posts, hub pages, locale roots)
  // get category=null — UI shows "Uncategorized" filter option.
  const { data: tierRows } = await db
    .from('product_tiers')
    .select('url, category')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .not('url', 'is', null)
  const categoryByPath = new Map<string, string>()
  for (const r of (tierRows ?? []) as Array<{ url: string | null; category: string | null }>) {
    if (!r.url || !r.category) continue
    const path = normalizePath(r.url)
    if (path && !categoryByPath.has(path)) categoryByPath.set(path, r.category)
  }

  // ── OAuth (shared `gsc_connections` for both GSC + GA4) ────────────────
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  let auth: OAuth2Client | null = null
  if (conn?.access_token && conn?.refresh_token) {
    try {
      const refreshed = await getRefreshedClientFull(
        conn.access_token as string,
        conn.refresh_token as string,
        (conn.expires_at as string | null) ?? new Date(0).toISOString(),
      )
      auth = refreshed.client
      if (refreshed.newCredentials) {
        void db
          .from('gsc_connections')
          .update({
            access_token: refreshed.newCredentials.accessToken,
            expires_at:   refreshed.newCredentials.expiresAt,
            updated_at:   new Date().toISOString(),
          })
          .eq('user_id', ownerId)
      }
    } catch (e) {
      diagnostics.ga4_error = `OAuth refresh: ${e instanceof Error ? e.message : String(e)}`
      diagnostics.gsc_error = diagnostics.ga4_error
    }
  } else {
    diagnostics.ga4_error = 'Google not connected — reconnect in Settings.'
    diagnostics.gsc_error = diagnostics.ga4_error
  }

  // ── Parallel fetch: GA4 revenue per [landingPage, country] + GSC [page, query, country] ───
  type Ga4Row = Record<string, string>
  // GSC rows have a known partial shape returned by webmasters API
  interface GscRowRaw { keys?: string[]; clicks?: number; impressions?: number; position?: number }

  const [ga4Rows, gscRows] = await Promise.all([
    (async (): Promise<Ga4Row[]> => {
      if (!auth || !ga4PropertyId) {
        if (!diagnostics.ga4_error) {
          diagnostics.ga4_error = !ga4PropertyId
            ? 'GA4 property id not configured for this site'
            : 'GA4 client unavailable'
        }
        return []
      }
      try {
        // Sprint FRIDAY.KPI.KW.FILTERS (340) — fetch with [landingPage, country]
        // so we can split revenue between US (all non-ID) and ID buckets.
        // GA4 country dim returns full names ("Indonesia", "United States").
        const analyticsdata = google.analyticsdata({ version: 'v1beta', auth })
        const res = await analyticsdata.properties.runReport({
          property: `properties/${ga4PropertyId}`,
          requestBody: {
            dateRanges: [{ startDate: weekStart, endDate: weekEnd }],
            dimensions: [{ name: 'landingPage' }, { name: 'country' }],
            metrics: [
              { name: 'sessions' },
              { name: 'purchaseRevenue' },
              { name: 'transactions' },
              { name: 'engagedSessions' },
            ],
            dimensionFilter: {
              filter: {
                fieldName: 'sessionDefaultChannelGroup',
                stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
              },
            },
            orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
            limit: '2000',
          },
        })
        const rows = parseGA4Rows(res.data)
        diagnostics.ga4_rows_fetched = rows.length
        return rows
      } catch (e) {
        diagnostics.ga4_error = `GA4 fetch: ${e instanceof Error ? e.message : String(e)}`
        return []
      }
    })(),
    (async (): Promise<GscRowRaw[]> => {
      if (!auth || !gscProperty) {
        if (!diagnostics.gsc_error) {
          diagnostics.gsc_error = !gscProperty
            ? 'GSC property not configured for this site'
            : 'GSC client unavailable'
        }
        return []
      }
      try {
        // Sprint FRIDAY.KPI.KW.FILTERS (340) — add country to dim so we can
        // split queries per market. Bump row cap to 10k to absorb the ~3x
        // expansion from adding a dim. GSC auto-truncates if needed.
        const rows = await getSearchAnalytics(
          auth, gscProperty, weekStart, weekEnd,
          ['page', 'query', 'country'], 10000,
        )
        diagnostics.gsc_rows_fetched = rows.length
        return rows as GscRowRaw[]
      } catch (e) {
        diagnostics.gsc_error = `GSC fetch: ${e instanceof Error ? e.message : String(e)}`
        return []
      }
    })(),
  ])

  // ── Aggregate GA4 per (page, market) ───────────────────────────────────
  // Market mapping: GA4 country == "Indonesia" → id; everything else → us.
  type Ga4Bucket = { sessions: number; revenue: number; transactions: number }
  const ga4UsByPath = new Map<string, Ga4Bucket>()
  const ga4IdByPath = new Map<string, Ga4Bucket>()
  for (const r of ga4Rows) {
    const path = normalizePath(r.landingPage ?? '')
    if (!path) continue
    const country = String(r.country ?? '').toLowerCase()
    const bucket  = country === 'indonesia' ? ga4IdByPath : ga4UsByPath
    const b = bucket.get(path) ?? { sessions: 0, revenue: 0, transactions: 0 }
    b.sessions     += Number(r.sessions        ?? 0)
    b.revenue      += Number(r.purchaseRevenue ?? 0)
    b.transactions += Number(r.transactions    ?? 0)
    bucket.set(path, b)
  }

  // ── Group GSC per (page, market), keep top 5 queries each ──────────────
  // Market mapping: GSC country == "idn" → id; everything else → us.
  type GscBucket = { queries: KeywordBreakdownQuery[] }
  const gscUsByPath = new Map<string, GscBucket>()
  const gscIdByPath = new Map<string, GscBucket>()
  for (const r of gscRows) {
    const page    = String(r.keys?.[0] ?? '')
    const query   = String(r.keys?.[1] ?? '')
    const country = String(r.keys?.[2] ?? '').toLowerCase()
    if (!page || !query) continue
    const path = normalizePath(page)
    if (!path) continue
    const bucket = country === 'idn' ? gscIdByPath : gscUsByPath
    const b = bucket.get(path) ?? { queries: [] }
    b.queries.push({
      query,
      rank:        r.position == null ? null : +Number(r.position).toFixed(1),
      clicks:      Number(r.clicks      ?? 0),
      impressions: Number(r.impressions ?? 0),
    })
    bucket.set(path, b)
  }

  // ── Merge into final row list ──────────────────────────────────────────
  const allPaths = new Set<string>([
    ...ga4UsByPath.keys(), ...ga4IdByPath.keys(),
    ...gscUsByPath.keys(), ...gscIdByPath.keys(),
  ])
  const merged: KeywordBreakdownRow[] = []
  const topQueriesOf = (bucket: GscBucket | undefined): KeywordBreakdownQuery[] => {
    if (!bucket) return []
    return bucket.queries
      .slice()
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 5)
  }
  const sliceOf = (ga: Ga4Bucket | undefined, gs: GscBucket | undefined): KeywordBreakdownMarketSlice => ({
    sessions:     ga?.sessions     ?? 0,
    transactions: ga?.transactions ?? 0,
    revenue:      +((ga?.revenue ?? 0)).toFixed(2),
    top_queries:  topQueriesOf(gs),
  })

  for (const path of allPaths) {
    const ga4Us = ga4UsByPath.get(path)
    const ga4Id = ga4IdByPath.get(path)
    const gscUs = gscUsByPath.get(path)
    const gscId = gscIdByPath.get(path)
    const inGa4 = !!(ga4Us || ga4Id)
    const inGsc = !!(gscUs || gscId)
    if (inGa4 && inGsc) diagnostics.matched_pages++
    else if (inGa4)     diagnostics.ga4_only_pages++
    else                diagnostics.gsc_only_pages++

    const us = sliceOf(ga4Us, gscUs)
    const id = sliceOf(ga4Id, gscId)

    // Aggregate (used for default "All markets" view) — combine top
    // queries across markets by re-sorting the union by clicks desc.
    const combinedQueries: KeywordBreakdownQuery[] = []
    const seen = new Set<string>()
    for (const q of [...us.top_queries, ...id.top_queries]) {
      if (seen.has(q.query)) continue
      seen.add(q.query)
      combinedQueries.push(q)
    }
    combinedQueries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)

    merged.push({
      page:         path,
      category:     categoryByPath.get(path) ?? null,
      sessions:     us.sessions     + id.sessions,
      transactions: us.transactions + id.transactions,
      revenue:      +((us.revenue + id.revenue)).toFixed(2),
      top_queries:  combinedQueries.slice(0, 5),
      us,
      id,
    })
  }

  // Sort by sessions desc (per Galih's preference). Tie-break by revenue.
  merged.sort((a, b) => b.sessions - a.sessions || b.revenue - a.revenue)

  // Cap at 200 rows — keeps the UI table reasonable and the JSON small.
  const capped = merged.slice(0, 200)

  return {
    site_slug:     siteSlug,
    week_start:    weekStart,
    week_end:      weekEnd,
    generated_at:  new Date().toISOString(),
    rows:          capped,
    diagnostics,
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
