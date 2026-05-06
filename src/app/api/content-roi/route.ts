import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import {
  getGA4RevenueByLandingPage,
  getGA4RevenueByPage,
  getGA4OrganicSessionsByPage,
} from '@/lib/ga4/client'

export const maxDuration = 60

// ── Helpers ───────────────────────────────────────────────────────────────────

// Normalize a path for matching: strip domain, strip locale prefix (/en/, /id/),
// lowercase, strip trailing slash
function normalizePath(raw: string): string {
  try {
    // If it looks like a full URL, extract pathname
    if (raw.startsWith('http')) {
      raw = new URL(raw).pathname
    }
  } catch { /* use as-is */ }
  return raw
    .toLowerCase()
    .replace(/^\/?(en|id)\//, '/')   // strip locale prefix
    .replace(/\/$/, '')              // strip trailing slash
    .replace(/^([^/])/, '/$1')      // ensure leading slash
}

// Check if a normalized GA4/GSC path matches a keyword map url_slug
// Strategy: the slug should appear as the last path segment or be contained
function slugMatchesPath(slug: string, normalizedPath: string): boolean {
  if (!slug || !normalizedPath) return false
  const s = slug.toLowerCase().replace(/^\//, '')
  // Exact tail match: /foo/bar/buy-ml-diamonds → slug=buy-ml-diamonds ✓
  if (normalizedPath.endsWith('/' + s) || normalizedPath === '/' + s) return true
  // Contains match (for nested slugs): /buy-ml-diamonds/cheap → slug=buy-ml-diamonds ✓
  if (normalizedPath.includes('/' + s)) return true
  return false
}

// ── GET /api/content-roi ──────────────────────────────────────────────────────
// Query params:
//   start   YYYY-MM-DD or GA4-style like '30daysAgo' (default: 30daysAgo)
//   end     YYYY-MM-DD or 'yesterday'               (default: yesterday)
//   map_id  filter to a specific keyword map
export async function GET(req: Request) {
  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  // Accept either YYYY-MM-DD or GA4-style relative ('30daysAgo','yesterday').
  // GA4 callbacks below accept relative strings, but GSC requires ISO dates,
  // so we convert here once and pass ISO to GSC + relative-pass-through to GA4.
  const fmtIso = (d: Date) => d.toISOString().slice(0, 10)
  function relToIso(s: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    if (s === 'today')     return fmtIso(new Date())
    if (s === 'yesterday') return fmtIso(new Date(Date.now() - 86400000))
    const m = s.match(/^(\d+)daysAgo$/)
    if (m) return fmtIso(new Date(Date.now() - Number(m[1]) * 86400000))
    return fmtIso(new Date(Date.now() - 30 * 86400000))   // safe default
  }
  const rawStart = searchParams.get('start') ?? '30daysAgo'
  const rawEnd   = searchParams.get('end')   ?? 'yesterday'
  const startDate     = rawStart   // GA4 compatible (accepts relative)
  const endDate       = rawEnd
  const startDateIso  = relToIso(rawStart)
  const endDateIso    = relToIso(rawEnd)
  const mapIdFilter   = searchParams.get('map_id') ?? null

  // ── 1. Fetch GSC connection + GSC site URL ────────────────────────────────
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  // GA4 property ID — env var first, then per-site config (system/health also
  // does this dual-source lookup, otherwise users who configured GA4 inside
  // /command-center get a false "not configured" warning here).
  let propertyId = process.env.GA4_PROPERTY_ID || ''
  if (!propertyId) {
    const { data: siteCfg } = await db
      .from('site_configs')
      .select('ga4_property_id')
      .eq('owner_user_id', ownerId)
      .not('ga4_property_id', 'is', null)
      .limit(1)
      .maybeSingle()
    if (siteCfg?.ga4_property_id) propertyId = String(siteCfg.ga4_property_id)
  }

  if (!conn?.access_token) {
    return NextResponse.json({ error: 'Google account not connected' }, { status: 422 })
  }

  const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)

  // ── 2. Fetch published keyword clusters from DB ───────────────────────────
  let query = db
    .from('keyword_map_clusters')
    .select(`
      id, keyword, url_slug, suggested_title, search_volume, difficulty,
      intent, content_type, cluster_group, is_pillar, source, created_at,
      map_id,
      keyword_maps!inner ( id, topic, topic_slug, market, status )
    `)
    .eq('owner_user_id', ownerId)
    .eq('status', 'published')
    .not('url_slug', 'is', null)

  if (mapIdFilter) {
    query = query.eq('map_id', mapIdFilter)
  }

  const { data: publishedClusters } = await query

  // ── 2b. Pipeline-published briefs (seo_content_briefs.status='published')
  // Treated as additional ROI rows alongside keyword_map_clusters. Both
  // surfaces represent "content that's live and should have measurable
  // impact". We dedup by URL — if the same page is in both sources, the
  // cluster row wins (it has richer cluster metadata).
  let publishedBriefs: Array<{
    id: string; primary_keyword: string | null; page: string | null
    brief_type: string | null; published_at: string | null; created_at: string
  }> = []
  if (!mapIdFilter) {
    const { data: briefRows } = await db
      .from('seo_content_briefs')
      .select('id, primary_keyword, page, brief_type, published_at, created_at')
      .eq('owner_user_id', ownerId)
      .eq('status', 'published')
      .not('page', 'is', null)
    publishedBriefs = (briefRows ?? []) as typeof publishedBriefs
  }

  if (!publishedClusters?.length && !publishedBriefs.length) {
    return NextResponse.json({
      clusters: [],
      summary: { totalPublished: 0, totalRevenueLanding: 0, totalRevenueOnPage: 0, totalClicks: 0, totalSessions: 0 },
    })
  }

  // ── 3. Pull GA4 + GSC data in parallel ───────────────────────────────────
  const [
    landingPageRevenue,
    onPageRevenue,
    organicSessions,
    gscRows,
  ] = await Promise.all([
    // GA4: Landing page revenue (organic → purchase in same session)
    propertyId ? getGA4RevenueByLandingPage(auth, propertyId, startDate, endDate, 1000).catch(() => []) : Promise.resolve([]),
    // GA4: On-page purchase events
    propertyId ? getGA4RevenueByPage(auth, propertyId, startDate, endDate, 1000).catch(() => []) : Promise.resolve([]),
    // GA4: Organic sessions per page
    propertyId ? getGA4OrganicSessionsByPage(auth, propertyId, startDate, endDate, 1000).catch(() => []) : Promise.resolve([]),
    // GSC: clicks + impressions + position per page (ISO dates required)
    conn.site_url
      ? getSearchAnalytics(auth, conn.site_url, startDateIso, endDateIso, ['page'], 5000).catch(() => [])
      : Promise.resolve([]),
  ])

  // ── 4. Build lookup maps ──────────────────────────────────────────────────

  // GA4 landing page revenue: normalizedPath → {revenue, transactions, sessions, engaged}
  const lpRevenueMap = new Map<string, { revenue: number; transactions: number; sessions: number; engaged: number }>()
  for (const row of landingPageRevenue) {
    const path = normalizePath(row.landingPage ?? '')
    lpRevenueMap.set(path, {
      revenue:      parseFloat(row.purchaseRevenue ?? '0'),
      transactions: parseInt(row.transactions ?? '0'),
      sessions:     parseInt(row.sessions ?? '0'),
      engaged:      parseInt(row.engagedSessions ?? '0'),
    })
  }

  // GA4 on-page revenue: normalizedPath → {revenue, transactions, views}
  const opRevenueMap = new Map<string, { revenue: number; transactions: number; views: number }>()
  for (const row of onPageRevenue) {
    const path = normalizePath(row.pagePath ?? '')
    opRevenueMap.set(path, {
      revenue:      parseFloat(row.purchaseRevenue ?? '0'),
      transactions: parseInt(row.transactions ?? '0'),
      views:        parseInt(row.screenPageViews ?? '0'),
    })
  }

  // GA4 organic sessions: normalizedPath → {sessions, engaged, bounce, avgDuration, views}
  const organicMap = new Map<string, { sessions: number; engaged: number; bounce: number; avgDuration: number; views: number }>()
  for (const row of organicSessions) {
    const path = normalizePath(row.pagePath ?? '')
    organicMap.set(path, {
      sessions:    parseInt(row.sessions ?? '0'),
      engaged:     parseInt(row.engagedSessions ?? '0'),
      bounce:      parseFloat(row.bounceRate ?? '0'),
      avgDuration: parseFloat(row.averageSessionDuration ?? '0'),
      views:       parseInt(row.screenPageViews ?? '0'),
    })
  }

  // GSC: normalizedUrl → {clicks, impressions, ctr, position, topKeyword}
  type GscEntry = { clicks: number; impressions: number; ctr: number; position: number }
  const gscMap = new Map<string, GscEntry>()
  for (const row of gscRows) {
    if (!row.keys?.[0]) continue
    const path = normalizePath(row.keys[0])
    gscMap.set(path, {
      clicks:      row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr:         row.ctr ?? 0,
      position:    row.position ?? 0,
    })
  }

  // ── 5. Match published clusters to GA4/GSC data ───────────────────────────
  // We match by url_slug against all normalized paths in our lookup maps
  // Strategy: find the best matching path in each map for each slug

  function findBestMatch<T>(slug: string, map: Map<string, T>): T | null {
    // Direct lookup first (exact: /slug)
    const direct = map.get('/' + slug.toLowerCase())
    if (direct) return direct
    // Scan all keys for slug-contains match
    for (const [path, val] of map) {
      if (slugMatchesPath(slug, path)) return val
    }
    return null
  }

  // ── 6. Build enriched cluster rows ────────────────────────────────────────
  const enriched = (publishedClusters ?? []).map(c => {
    const slug = c.url_slug ?? ''
    const map  = c.keyword_maps as unknown as { id: string; topic: string; topic_slug: string; market: string; status: string }

    const lp  = findBestMatch(slug, lpRevenueMap)
    const op  = findBestMatch(slug, opRevenueMap)
    const org = findBestMatch(slug, organicMap)
    const gsc = findBestMatch(slug, gscMap)

    return {
      // Cluster info
      id:             c.id,
      map_id:         c.map_id,
      map_topic:      map?.topic ?? '',
      map_market:     map?.market ?? 'us',
      keyword:        c.keyword,
      url_slug:       slug,
      source:         'keyword_map' as 'keyword_map' | 'pipeline_brief',
      suggested_title: c.suggested_title,
      search_volume:  c.search_volume,
      difficulty:     c.difficulty,
      intent:         c.intent,
      content_type:   c.content_type,
      cluster_group:  c.cluster_group,
      is_pillar:      c.is_pillar,
      published_at:   c.created_at,

      // GSC
      gsc_clicks:       gsc?.clicks ?? 0,
      gsc_impressions:  gsc?.impressions ?? 0,
      gsc_ctr:          gsc?.ctr ?? 0,
      gsc_position:     gsc?.position ?? null,

      // GA4 organic sessions
      ga4_sessions:        org?.sessions ?? 0,
      ga4_engaged:         org?.engaged ?? 0,
      ga4_bounce_rate:     org?.bounce ?? 0,
      ga4_avg_duration:    org?.avgDuration ?? 0,
      ga4_views:           org?.views ?? 0,

      // Revenue — landing page attribution (default/SEO-relevant)
      revenue_landing:       lp?.revenue ?? 0,
      transactions_landing:  lp?.transactions ?? 0,
      sessions_landing:      lp?.sessions ?? 0,

      // Revenue — on-page purchase events
      revenue_on_page:       op?.revenue ?? 0,
      transactions_on_page:  op?.transactions ?? 0,

      // Computed: Revenue per click (landing page model)
      rpc: gsc?.clicks ? (lp?.revenue ?? 0) / gsc.clicks : 0,
      // Revenue per session
      rps: (org?.sessions ?? 0) > 0 ? (lp?.revenue ?? 0) / (org?.sessions ?? 1) : 0,
    }
  })

  // ── 6b. Append pipeline-published briefs (dedup by url_slug) ─────────────
  // Match brief.page (full URL) → strip to slug → skip if already in `enriched`
  // from keyword_map. Otherwise enrich with same GA4/GSC lookups.
  const existingSlugs = new Set(enriched.map(e => e.url_slug.toLowerCase()))
  function urlToSlug(url: string): string {
    try {
      const u = new URL(url)
      return u.pathname.split('/').filter(Boolean).pop() ?? ''
    } catch {
      return url.split('/').filter(Boolean).pop() ?? ''
    }
  }

  for (const b of publishedBriefs) {
    const slug = urlToSlug(String(b.page ?? ''))
    if (!slug || existingSlugs.has(slug.toLowerCase())) continue

    const lp  = findBestMatch(slug, lpRevenueMap)
    const op  = findBestMatch(slug, opRevenueMap)
    const org = findBestMatch(slug, organicMap)
    const gsc = findBestMatch(slug, gscMap)

    enriched.push({
      id:              b.id,
      map_id:          '',
      map_topic:       b.brief_type ?? 'pipeline',     // shows brief_type as group label
      map_market:      'us',
      keyword:         b.primary_keyword ?? slug,
      url_slug:        slug,
      source:          'pipeline_brief' as const,
      suggested_title: null,
      search_volume:   null,
      difficulty:      null,
      intent:          null,
      content_type:    b.brief_type,
      cluster_group:   null,
      is_pillar:       false,
      published_at:    b.published_at ?? b.created_at,
      gsc_clicks:       gsc?.clicks ?? 0,
      gsc_impressions:  gsc?.impressions ?? 0,
      gsc_ctr:          gsc?.ctr ?? 0,
      gsc_position:     gsc?.position ?? null,
      ga4_sessions:        org?.sessions ?? 0,
      ga4_engaged:         org?.engaged ?? 0,
      ga4_bounce_rate:     org?.bounce ?? 0,
      ga4_avg_duration:    org?.avgDuration ?? 0,
      ga4_views:           org?.views ?? 0,
      revenue_landing:       lp?.revenue ?? 0,
      transactions_landing:  lp?.transactions ?? 0,
      sessions_landing:      lp?.sessions ?? 0,
      revenue_on_page:       op?.revenue ?? 0,
      transactions_on_page:  op?.transactions ?? 0,
      rpc: gsc?.clicks ? (lp?.revenue ?? 0) / gsc.clicks : 0,
      rps: (org?.sessions ?? 0) > 0 ? (lp?.revenue ?? 0) / (org?.sessions ?? 1) : 0,
    } as typeof enriched[number])
    existingSlugs.add(slug.toLowerCase())
  }

  // ── 7. Summary ────────────────────────────────────────────────────────────
  const summary = {
    totalPublished:        enriched.length,
    totalRevenueLanding:   enriched.reduce((s, c) => s + c.revenue_landing, 0),
    totalRevenueOnPage:    enriched.reduce((s, c) => s + c.revenue_on_page, 0),
    totalClicks:           enriched.reduce((s, c) => s + c.gsc_clicks, 0),
    totalImpressions:      enriched.reduce((s, c) => s + c.gsc_impressions, 0),
    totalSessions:         enriched.reduce((s, c) => s + c.ga4_sessions, 0),
    totalTransactions:     enriched.reduce((s, c) => s + c.transactions_landing, 0),
    topByRevenue:          enriched.sort((a, b) => b.revenue_landing - a.revenue_landing)[0]?.keyword ?? null,
    topByClicks:           [...enriched].sort((a, b) => b.gsc_clicks - a.gsc_clicks)[0]?.keyword ?? null,
    ga4Available:          !!propertyId,
  }

  return NextResponse.json({ clusters: enriched, summary })
}
