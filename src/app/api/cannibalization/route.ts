import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'

export const maxDuration = 60

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

// How evenly split is traffic between pages? 0 = one page dominates, 1 = perfect 50/50 split
function splitScore(values: number[]): number {
  const total = values.reduce((s, v) => s + v, 0)
  if (total === 0) return 0
  const max = Math.max(...values)
  return 1 - (max / total)
}

// Jaccard similarity between two keyword token sets
function tokenize(kw: string): Set<string> {
  const stop = new Set(['buy','sell','cheap','best','top','free','how','get','the','a','an','for','of','in','on','to','and','or'])
  return new Set(
    kw.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stop.has(t))
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter(t => b.has(t)).length
  const union = new Set([...a, ...b]).size
  return union === 0 ? 0 : intersection / union
}

function recommend(pages: { page: string; clicks: number; impressions: number; position: number }[], split: number): string {
  const sorted = [...pages].sort((a, b) => b.clicks - a.clicks)
  const [top, second] = sorted

  if (!second) return 'No issue'

  // One page gets zero clicks — likely invisible
  if (second.clicks === 0 && top.impressions > 50) {
    return `Canonicalize or 301: "${extractPath(second.page)}" gets impressions but no clicks — point it to the dominant page.`
  }
  // Very even split — both pages actively competing
  if (split > 0.65) {
    return 'Differentiate intent: both pages getting similar traffic. Clarify unique angle for each, or merge into one authoritative page.'
  }
  // Dominant page but secondary still getting traffic
  if (split > 0.3) {
    return 'Review & consolidate: consider whether the lower-ranked page adds unique value. If not, 301 redirect to the stronger page.'
  }
  // Mostly one page dominates by position
  if (top.position < second.position - 5) {
    return 'Monitor: one page clearly dominates. Set canonical on weaker page to reinforce the winner.'
  }
  return 'Review: both pages ranking for the same query — verify they serve distinct user intents.'
}

// ── GET /api/cannibalization ──────────────────────────────────────────────────
// Query params:
//   days     lookback window (default 90)
//   min_impr minimum impressions to surface a query (default 10)
export async function GET(req: Request) {
  try {
    return await handleGET(req)
  } catch (err) {
    console.error('[cannibalization] Unhandled error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

async function handleGET(req: Request) {
  // Cron-internal call path: cron passes ?cron_secret=…&owner=… so we can run
  // detection on behalf of an owner without an auth cookie. Required for the
  // /api/cron/cannib-snapshot weekly persister.
  const url = new URL(req.url)
  const cronSecret = url.searchParams.get('cron_secret')
  const cronOwner  = url.searchParams.get('owner')
  let ownerId: string

  if (cronSecret && cronOwner && cronSecret === process.env.CRON_SECRET) {
    ownerId = cronOwner
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ownerId = await getEffectiveOwnerId(supabase, user.id)
  }

  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days    = parseInt(searchParams.get('days')     ?? '90')
  const minImpr = parseInt(searchParams.get('min_impr') ?? '10')

  // ── 1. GSC connection ───────────────────────────────────────────────────────
  // Use the service client for the connection lookup so cron-context calls
  // (which have no user session / cookie) can still fetch the row.
  const { data: conn } = await db
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  if (!conn?.access_token || !conn?.site_url) {
    return NextResponse.json({ error: 'GSC not connected' }, { status: 422 })
  }

  const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
  // GSC API requires YYYY-MM-DD, NOT GA4-style relative strings like "90daysAgo".
  // Convert here so callers can keep using the friendly day-count param.
  const today    = new Date()
  const yest     = new Date(today.getTime() - 86400000)
  const startD   = new Date(today.getTime() - days * 86400000)
  const fmt      = (d: Date) => d.toISOString().slice(0, 10)
  const startDate = fmt(startD)
  const endDate   = fmt(yest)

  // ── 2. Pull GSC query+page data ─────────────────────────────────────────────
  // This gives us: for each (query, page) pair, clicks/impressions/ctr/position
  const rows = (await getSearchAnalytics(
    auth, conn.site_url, startDate, endDate,
    ['query', 'page'],
    10000   // 25k rows can timeout; 10k is enough for cannibalization detection
  )) ?? []

  // ── 3. Group by query, find queries with 2+ pages ───────────────────────────
  type PageEntry = { page: string; clicks: number; impressions: number; ctr: number; position: number }
  const queryMap = new Map<string, PageEntry[]>()

  for (const row of rows) {
    const query = row.keys?.[0]
    const page  = row.keys?.[1]
    if (!query || !page) continue

    if (!queryMap.has(query)) queryMap.set(query, [])
    queryMap.get(query)!.push({
      page,
      clicks:      row.clicks      ?? 0,
      impressions: row.impressions ?? 0,
      ctr:         row.ctr         ?? 0,
      position:    Math.round((row.position ?? 0) * 10) / 10,
    })
  }

  // ── 4. Build keyword map lookup (cluster keyword → {map_topic, url_slug}) ───
  const { data: clusters } = await db
    .from('keyword_map_clusters')
    .select('keyword, url_slug, map_id, keyword_maps!inner(topic)')
    .eq('owner_user_id', ownerId)

  type ClusterEntry = { keyword: string; url_slug: string | null; map_topic: string }
  const clusterList: ClusterEntry[] = (clusters ?? []).map(c => ({
    keyword:   c.keyword,
    url_slug:  c.url_slug,
    map_topic: (c.keyword_maps as unknown as { topic: string })?.topic ?? '',
  }))

  // Build token sets for all clusters (for Jaccard matching)
  const clusterTokens = clusterList.map(c => ({ ...c, tokens: tokenize(c.keyword) }))

  // For each GSC query, find best matching keyword map cluster
  function findClusterMatch(query: string): ClusterEntry | null {
    const qt = tokenize(query)
    let best: ClusterEntry | null = null
    let bestScore = 0.5  // minimum threshold

    for (const c of clusterTokens) {
      const score = jaccard(qt, c.tokens)
      if (score > bestScore) { bestScore = score; best = c }
    }
    return best
  }

  // ── 5. Build cannibalization groups ─────────────────────────────────────────
  type CannibalPage = PageEntry & { cluster?: ClusterEntry | null }

  interface CannibalGroup {
    query: string
    pages: CannibalPage[]
    total_clicks: number
    total_impressions: number
    split_score: number
    severity: 'critical' | 'warning' | 'info'
    recommendation: string
    map_topic: string | null
  }

  const groups: CannibalGroup[] = []

  for (const [query, pages] of queryMap) {
    if (pages.length < 2) continue
    const totalImpr = pages.reduce((s, p) => s + p.impressions, 0)
    if (totalImpr < minImpr) continue

    const totalClicks = pages.reduce((s, p) => s + p.clicks, 0)
    const split       = splitScore(pages.map(p => p.clicks))
    const clusterMatch = findClusterMatch(query)

    // Severity
    let severity: 'critical' | 'warning' | 'info' = 'info'
    if (totalClicks >= 20 && split >= 0.3)       severity = 'critical'
    else if (totalClicks >= 5 || totalImpr >= 100) severity = 'warning'

    const enrichedPages: CannibalPage[] = pages
      .map(p => ({ ...p, cluster: clusterMatch }))
      .sort((a, b) => b.clicks - a.clicks)

    groups.push({
      query,
      pages: enrichedPages,
      total_clicks:      totalClicks,
      total_impressions: totalImpr,
      split_score:       Math.round(split * 100) / 100,
      severity,
      recommendation: recommend(enrichedPages, split),
      map_topic: clusterMatch?.map_topic ?? null,
    })
  }

  // Sort: critical first, then by total clicks desc
  const sortedGroups = groups.sort((a, b) => {
    const sOrder = { critical: 0, warning: 1, info: 2 }
    const so = sOrder[a.severity] - sOrder[b.severity]
    return so !== 0 ? so : b.total_clicks - a.total_clicks
  })

  // ── 6. Keyword Map overlap detection (planned cannibalization) ───────────────
  // Find cluster pairs across maps with high keyword similarity
  interface MapOverlap {
    keyword_a:  string
    slug_a:     string | null
    map_topic_a: string
    keyword_b:  string
    slug_b:     string | null
    map_topic_b: string
    similarity: number
    type: 'exact' | 'near_exact' | 'similar'
  }

  const mapOverlaps: MapOverlap[] = []
  const seenPairs = new Set<string>()
  // Cap at 800 clusters to prevent O(n²) timeout (800*799/2 ≈ 319K pairs max)
  const cappedClusters = clusterTokens.slice(0, 800)

  for (let i = 0; i < cappedClusters.length; i++) {
    for (let j = i + 1; j < cappedClusters.length; j++) {
      const a = cappedClusters[i]
      const b = cappedClusters[j]

      const pairKey = [a.keyword, b.keyword].sort().join('|||')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      const sim = jaccard(a.tokens, b.tokens)
      if (sim < 0.6) continue

      let type: 'exact' | 'near_exact' | 'similar' = 'similar'
      if (a.keyword.toLowerCase() === b.keyword.toLowerCase()) type = 'exact'
      else if (sim >= 0.85) type = 'near_exact'

      mapOverlaps.push({
        keyword_a:   a.keyword,
        slug_a:      a.url_slug,
        map_topic_a: a.map_topic,
        keyword_b:   b.keyword,
        slug_b:      b.url_slug,
        map_topic_b: b.map_topic,
        similarity:  Math.round(sim * 100) / 100,
        type,
      })
    }
  }

  const sortedOverlaps = mapOverlaps
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 100)

  // ── 7. Summary ───────────────────────────────────────────────────────────────
  const summary = {
    totalQueriesScanned:  queryMap.size,
    cannibalisedQueries:  sortedGroups.length,
    criticalCount:        sortedGroups.filter(g => g.severity === 'critical').length,
    warningCount:         sortedGroups.filter(g => g.severity === 'warning').length,
    infoCount:            sortedGroups.filter(g => g.severity === 'info').length,
    estimatedLostClicks:  Math.round(
      sortedGroups
        .filter(g => g.severity !== 'info')
        .reduce((s, g) => s + g.total_clicks * g.split_score * 0.5, 0)
    ),
    mapOverlapCount: sortedOverlaps.length,
    dateRange: `Last ${days} days`,
  }

  return NextResponse.json({
    summary,
    groups:   sortedGroups.slice(0, 500),
    overlaps: sortedOverlaps,
  })
}
