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
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getGA4RevenueByLandingPage } from '@/lib/ga4/client'

export interface KeywordBreakdownQuery {
  query:       string
  rank:        number | null   // GSC position (avg over window)
  clicks:      number
  impressions: number
}

export interface KeywordBreakdownRow {
  page:         string         // normalized path, e.g. '/categories/blade-and-soul-neo'
  sessions:     number         // GA4 organic sessions
  transactions: number         // GA4 organic purchases
  revenue:      number         // GA4 purchaseRevenue (currency = GA4 property default)
  top_queries:  KeywordBreakdownQuery[]   // up to 5, sorted by clicks desc
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

  // ── Parallel fetch: GA4 revenue per landingPage + GSC page×query ───────
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
        const rows = await getGA4RevenueByLandingPage(auth, ga4PropertyId, weekStart, weekEnd, 500)
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
        // dim=['page','query']: per landing page × query.
        // 5000 rows comfortably covers the top of the long tail.
        const rows = await getSearchAnalytics(auth, gscProperty, weekStart, weekEnd, ['page', 'query'], 5000)
        diagnostics.gsc_rows_fetched = rows.length
        return rows as GscRowRaw[]
      } catch (e) {
        diagnostics.gsc_error = `GSC fetch: ${e instanceof Error ? e.message : String(e)}`
        return []
      }
    })(),
  ])

  // ── Aggregate GA4 by normalized page path ──────────────────────────────
  type Ga4Bucket = { sessions: number; revenue: number; transactions: number }
  const ga4ByPath = new Map<string, Ga4Bucket>()
  for (const r of ga4Rows) {
    const path = normalizePath(r.landingPage ?? '')
    if (!path) continue
    const b = ga4ByPath.get(path) ?? { sessions: 0, revenue: 0, transactions: 0 }
    b.sessions     += Number(r.sessions        ?? 0)
    b.revenue      += Number(r.purchaseRevenue ?? 0)
    b.transactions += Number(r.transactions    ?? 0)
    ga4ByPath.set(path, b)
  }

  // ── Group GSC by normalized page, keep top 5 queries by clicks ─────────
  type GscBucket = { queries: KeywordBreakdownQuery[] }
  const gscByPath = new Map<string, GscBucket>()
  for (const r of gscRows) {
    const page  = String(r.keys?.[0] ?? '')
    const query = String(r.keys?.[1] ?? '')
    if (!page || !query) continue
    const path = normalizePath(page)
    if (!path) continue
    const b = gscByPath.get(path) ?? { queries: [] }
    b.queries.push({
      query,
      rank:        r.position == null ? null : +Number(r.position).toFixed(1),
      clicks:      Number(r.clicks      ?? 0),
      impressions: Number(r.impressions ?? 0),
    })
    gscByPath.set(path, b)
  }

  // ── Merge into final row list ──────────────────────────────────────────
  const allPaths = new Set<string>([...ga4ByPath.keys(), ...gscByPath.keys()])
  const merged: KeywordBreakdownRow[] = []
  for (const path of allPaths) {
    const ga4 = ga4ByPath.get(path)
    const gsc = gscByPath.get(path)
    const inGa4 = !!ga4
    const inGsc = !!gsc
    if (inGa4 && inGsc) diagnostics.matched_pages++
    else if (inGa4)     diagnostics.ga4_only_pages++
    else                diagnostics.gsc_only_pages++

    // Top 5 queries by clicks desc (with tiebreak by impressions)
    const topQueries = (gsc?.queries ?? [])
      .slice()
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 5)

    merged.push({
      page:         path,
      sessions:     ga4?.sessions     ?? 0,
      transactions: ga4?.transactions ?? 0,
      revenue:      +(ga4?.revenue ?? 0).toFixed(2),
      top_queries:  topQueries,
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
