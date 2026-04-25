import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalyticsByCountry } from '@/lib/gsc/client'

export const maxDuration = 60

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizePath(url: string): string {
  try {
    const path = new URL(url).pathname
    return path.toLowerCase().replace(/^\/(en|id)(\/|$)/, '/').replace(/\/$/, '') || '/'
  } catch {
    return url.toLowerCase().replace(/^\/(en|id)(\/|$)/, '/').replace(/\/$/, '') || '/'
  }
}

function round1(n: number) { return Math.round(n * 10) / 10 }

// ── GET /api/multi-market ─────────────────────────────────────────────────────
// Query params:
//   days       lookback window (default 90)
//   market_a   GSC country code, default 'usa'
//   market_b   GSC country code, default 'idn'
//   min_impr   minimum impressions to include a query (default 5)
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { searchParams } = new URL(req.url)
  const days     = parseInt(searchParams.get('days')     ?? '90')
  const marketA  = searchParams.get('market_a') ?? 'usa'
  const marketB  = searchParams.get('market_b') ?? 'idn'
  const minImpr  = parseInt(searchParams.get('min_impr') ?? '5')

  // ── 1. GSC connection ─────────────────────────────────────────────────────
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  if (!conn?.access_token || !conn?.site_url) {
    return NextResponse.json({ error: 'GSC not connected' }, { status: 422 })
  }

  const auth      = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
  const startDate = `${days}daysAgo`
  const endDate   = 'yesterday'

  // ── 2. Fetch both markets concurrently ────────────────────────────────────
  const [rowsA, rowsB] = await Promise.all([
    getSearchAnalyticsByCountry(auth, conn.site_url, startDate, endDate, marketA, ['query', 'page'], 15000).catch(() => []),
    getSearchAnalyticsByCountry(auth, conn.site_url, startDate, endDate, marketB, ['query', 'page'], 15000).catch(() => []),
  ])

  // ── 3. Build per-query maps: query → {clicks, impressions, position, pages} ─
  type MarketEntry = {
    clicks: number
    impressions: number
    position: number
    pages: { page: string; path: string; clicks: number; impressions: number; position: number }[]
  }

  function buildQueryMap(rows: typeof rowsA): Map<string, MarketEntry> {
    const map = new Map<string, MarketEntry>()
    for (const row of rows) {
      const query = row.keys?.[0]
      const page  = row.keys?.[1]
      if (!query || !page) continue
      if (!map.has(query)) {
        map.set(query, { clicks: 0, impressions: 0, position: 0, pages: [] })
      }
      const entry = map.get(query)!
      entry.clicks      += row.clicks      ?? 0
      entry.impressions += row.impressions ?? 0
      // store best position
      const pos = row.position ?? 100
      if (entry.pages.length === 0 || pos < entry.position || entry.position === 0) {
        entry.position = pos
      }
      entry.pages.push({
        page,
        path:        normalizePath(page),
        clicks:      row.clicks      ?? 0,
        impressions: row.impressions ?? 0,
        position:    pos,
      })
    }
    // Average position properly (weighted by impressions)
    for (const [, entry] of map) {
      const totalImpr = entry.pages.reduce((s, p) => s + p.impressions, 0)
      if (totalImpr > 0) {
        entry.position = entry.pages.reduce((s, p) => s + p.position * p.impressions, 0) / totalImpr
      }
    }
    return map
  }

  const mapA = buildQueryMap(rowsA)
  const mapB = buildQueryMap(rowsB)

  // ── 4. Build per-page maps: path → {clicks, impressions} ─────────────────
  function buildPageMap(rows: typeof rowsA): Map<string, { clicks: number; impressions: number; url: string }> {
    const map = new Map<string, { clicks: number; impressions: number; url: string }>()
    for (const row of rows) {
      const page = row.keys?.[1]
      if (!page) continue
      const path = normalizePath(page)
      if (!map.has(path)) map.set(path, { clicks: 0, impressions: 0, url: page })
      const entry = map.get(path)!
      entry.clicks      += row.clicks      ?? 0
      entry.impressions += row.impressions ?? 0
    }
    return map
  }

  const pageMapA = buildPageMap(rowsA)
  const pageMapB = buildPageMap(rowsB)

  // ── 5. Query comparison ───────────────────────────────────────────────────
  type QueryCompareRow = {
    query:         string
    a_clicks:      number
    a_impressions: number
    a_position:    number | null
    b_clicks:      number
    b_impressions: number
    b_position:    number | null
    presence:      'both' | 'a_only' | 'b_only'
    position_diff: number | null   // a_position - b_position (negative = A ranks higher)
  }

  const allQueries = new Set([...mapA.keys(), ...mapB.keys()])
  const queryRows: QueryCompareRow[] = []

  for (const query of allQueries) {
    const entA = mapA.get(query)
    const entB = mapB.get(query)

    const totalImpr = (entA?.impressions ?? 0) + (entB?.impressions ?? 0)
    if (totalImpr < minImpr) continue

    const posA = entA ? round1(entA.position) : null
    const posB = entB ? round1(entB.position) : null

    queryRows.push({
      query,
      a_clicks:      entA?.clicks      ?? 0,
      a_impressions: entA?.impressions ?? 0,
      a_position:    posA,
      b_clicks:      entB?.clicks      ?? 0,
      b_impressions: entB?.impressions ?? 0,
      b_position:    posB,
      presence:      entA && entB ? 'both' : entA ? 'a_only' : 'b_only',
      position_diff: posA !== null && posB !== null ? round1(posA - posB) : null,
    })
  }

  // Sort: both first by total clicks, then a_only, then b_only
  const presenceOrder = { both: 0, a_only: 1, b_only: 2 }
  queryRows.sort((a, b) => {
    const po = presenceOrder[a.presence] - presenceOrder[b.presence]
    if (po !== 0) return po
    return (b.a_clicks + b.b_clicks) - (a.a_clicks + a.b_clicks)
  })

  // ── 6. Content gap: pages with traffic in one market but absent in the other ─
  type ContentGap = {
    url:       string
    path:      string
    clicks:    number
    impressions: number
    gap_type:  'a_only' | 'b_only'
  }

  const contentGaps: ContentGap[] = []
  const PAGE_MIN_IMPR = 20

  for (const [path, data] of pageMapA) {
    if (data.impressions < PAGE_MIN_IMPR) continue
    const inB = pageMapB.get(path)
    if (!inB || inB.impressions === 0) {
      contentGaps.push({ url: data.url, path, clicks: data.clicks, impressions: data.impressions, gap_type: 'a_only' })
    }
  }
  for (const [path, data] of pageMapB) {
    if (data.impressions < PAGE_MIN_IMPR) continue
    const inA = pageMapA.get(path)
    if (!inA || inA.impressions === 0) {
      contentGaps.push({ url: data.url, path, clicks: data.clicks, impressions: data.impressions, gap_type: 'b_only' })
    }
  }
  contentGaps.sort((a, b) => b.impressions - a.impressions)

  // ── 7. Ranking opportunities: queries where one market ranks much worse ────
  type RankOpportunity = {
    query:         string
    weak_market:   'a' | 'b'
    weak_position: number
    strong_position: number
    position_gap:  number
    impressions:   number
    clicks:        number
  }

  const opportunities: RankOpportunity[] = []
  const MIN_POS_GAP = 10

  for (const row of queryRows) {
    if (row.presence !== 'both') continue
    if (row.a_position === null || row.b_position === null) continue
    const gap = Math.abs(row.position_diff ?? 0)
    if (gap < MIN_POS_GAP) continue

    const weakMarket   = row.a_position > row.b_position ? 'a' : 'b'
    const weakPos      = weakMarket === 'a' ? row.a_position : row.b_position
    const strongPos    = weakMarket === 'a' ? row.b_position : row.a_position
    const imprForWeak  = weakMarket === 'a' ? row.a_impressions : row.b_impressions
    const clicksForWeak = weakMarket === 'a' ? row.a_clicks : row.b_clicks

    opportunities.push({
      query:          row.query,
      weak_market:    weakMarket,
      weak_position:  round1(weakPos),
      strong_position: round1(strongPos),
      position_gap:   round1(gap),
      impressions:    imprForWeak,
      clicks:         clicksForWeak,
    })
  }
  opportunities.sort((a, b) => b.position_gap - a.position_gap)

  // ── 8. Summary ────────────────────────────────────────────────────────────
  const totalClicksA  = [...pageMapA.values()].reduce((s, p) => s + p.clicks, 0)
  const totalClicksB  = [...pageMapB.values()].reduce((s, p) => s + p.clicks, 0)
  const totalImprA    = [...pageMapA.values()].reduce((s, p) => s + p.impressions, 0)
  const totalImprB    = [...pageMapB.values()].reduce((s, p) => s + p.impressions, 0)

  const bothCount   = queryRows.filter(r => r.presence === 'both').length
  const aOnlyCount  = queryRows.filter(r => r.presence === 'a_only').length
  const bOnlyCount  = queryRows.filter(r => r.presence === 'b_only').length

  const avgPosA = queryRows.filter(r => r.a_position !== null).reduce((s, r, _, arr) => s + (r.a_position ?? 0) / arr.length, 0)
  const avgPosB = queryRows.filter(r => r.b_position !== null).reduce((s, r, _, arr) => s + (r.b_position ?? 0) / arr.length, 0)

  const summary = {
    market_a:         marketA,
    market_b:         marketB,
    date_range:       `Last ${days} days`,
    total_clicks_a:   totalClicksA,
    total_clicks_b:   totalClicksB,
    total_impr_a:     totalImprA,
    total_impr_b:     totalImprB,
    avg_position_a:   round1(avgPosA),
    avg_position_b:   round1(avgPosB),
    queries_total:    queryRows.length,
    queries_both:     bothCount,
    queries_a_only:   aOnlyCount,
    queries_b_only:   bOnlyCount,
    content_gaps_a:   contentGaps.filter(g => g.gap_type === 'a_only').length,
    content_gaps_b:   contentGaps.filter(g => g.gap_type === 'b_only').length,
    opportunities:    opportunities.length,
  }

  return NextResponse.json({
    summary,
    queries:      queryRows.slice(0, 1000),
    contentGaps:  contentGaps.slice(0, 200),
    opportunities: opportunities.slice(0, 200),
  })
}
