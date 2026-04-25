import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getOnPagePages, getOnPageLinks } from '@/lib/dataforseo/client'

export const maxDuration = 60

// ── URL helpers ───────────────────────────────────────────────────────────────

function extractPath(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase().replace(/\/$/, '') || '/'
  } catch {
    return url.toLowerCase().replace(/\/$/, '') || '/'
  }
}

// Does a crawled path match a keyword map url_slug?
function slugMatchesPath(slug: string, path: string): boolean {
  if (!slug || !path) return false
  const s = '/' + slug.toLowerCase().replace(/^\//, '')
  return path === s || path.endsWith(s) || path.includes(s + '/')
}

// ── GET /api/internal-links ───────────────────────────────────────────────────
// Returns:
//   orphans      — published KW map pages with few/no inbound internal links
//   opportunities — intra-cluster page pairs that don't link to each other
//   pages        — all crawled pages with link counts
//   task         — the audit task used
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { searchParams } = new URL(req.url)
  const taskIdOverride = searchParams.get('task_id')

  // ── 1. Resolve crawl task ───────────────────────────────────────────────────
  let taskId: string | null = taskIdOverride

  if (!taskId) {
    const { data: tasks } = await db
      .from('site_audit_tasks')
      .select('task_id, status, target, created_at')
      .eq('owner_user_id', ownerId)
      .eq('status', 'finished')
      .order('created_at', { ascending: false })
      .limit(1)

    taskId = tasks?.[0]?.task_id ?? null
  }

  if (!taskId) {
    return NextResponse.json({ error: 'No finished site audit found. Run a site audit first.', needsAudit: true }, { status: 422 })
  }

  // ── 2. Fetch link data from DataForSEO ─────────────────────────────────────
  const [pages, links] = await Promise.all([
    getOnPagePages(taskId, 2000),
    getOnPageLinks(taskId, 10000),
  ])

  if (!pages.length) {
    return NextResponse.json({ error: 'Crawl data unavailable. The audit task may have expired.', needsAudit: true }, { status: 422 })
  }

  // ── 3. Fetch published keyword map clusters ─────────────────────────────────
  const { data: clusters } = await db
    .from('keyword_map_clusters')
    .select(`
      id, keyword, url_slug, is_pillar, cluster_group, map_id,
      keyword_maps!inner ( id, topic, topic_slug )
    `)
    .eq('owner_user_id', ownerId)
    .not('url_slug', 'is', null)

  const allClusters = clusters ?? []

  // ── 4. Build lookup structures ──────────────────────────────────────────────

  // Path → page data
  const pageMap = new Map<string, typeof pages[0]>()
  for (const p of pages) {
    pageMap.set(extractPath(p.url), p)
  }

  // link_from_path → Set of link_to_paths
  const linksFromMap = new Map<string, Set<string>>()
  // link_to_path → Set of link_from_paths (with anchor text)
  const linksToMap   = new Map<string, { from: string; anchor: string | null; dofollow: boolean }[]>()

  for (const link of links) {
    const from = extractPath(link.link_from)
    const to   = extractPath(link.link_to)
    if (!from || !to || from === to) continue

    if (!linksFromMap.has(from)) linksFromMap.set(from, new Set())
    linksFromMap.get(from)!.add(to)

    if (!linksToMap.has(to)) linksToMap.set(to, [])
    linksToMap.get(to)!.push({ from, anchor: link.anchor, dofollow: link.dofollow })
  }

  // Find best matching path for a slug
  function findPathForSlug(slug: string): string | null {
    const direct = '/' + slug.toLowerCase()
    if (pageMap.has(direct)) return direct
    for (const path of pageMap.keys()) {
      if (slugMatchesPath(slug, path)) return path
    }
    return null
  }

  // ── 5. Enrich clusters with link data ──────────────────────────────────────
  type EnrichedCluster = {
    id: string
    keyword: string
    url_slug: string
    map_id: string
    map_topic: string
    is_pillar: boolean
    cluster_group: string | null
    resolved_path: string | null
    inlinks_count: number
    outlinks_count: number
    inlinks: { from: string; anchor: string | null; dofollow: boolean }[]
  }

  const enriched: EnrichedCluster[] = allClusters.map(c => {
    const slug = c.url_slug!
    const map  = c.keyword_maps as unknown as { id: string; topic: string; topic_slug: string }
    const path = findPathForSlug(slug)
    const page = path ? pageMap.get(path) : null
    const inlinks = path ? (linksToMap.get(path) ?? []) : []

    return {
      id:            c.id,
      keyword:       c.keyword,
      url_slug:      slug,
      map_id:        c.map_id,
      map_topic:     map?.topic ?? '',
      is_pillar:     c.is_pillar,
      cluster_group: c.cluster_group,
      resolved_path: path,
      inlinks_count: page?.inlinks_count ?? inlinks.length,
      outlinks_count: page?.links_internal ?? 0,
      inlinks,
    }
  })

  // ── 6. Orphan detection ─────────────────────────────────────────────────────
  // Threshold: pages with fewer than 3 inbound internal links are "weakly linked"
  const ORPHAN_THRESHOLD = 3

  const orphans = enriched
    .filter(c => c.inlinks_count < ORPHAN_THRESHOLD)
    .map(c => {
      // Suggest pages that should link to this orphan:
      // Same topic cluster pages that have outbound links available
      const sameTopicPages = enriched.filter(other =>
        other.id !== c.id &&
        other.map_id === c.map_id &&
        (other.outlinks_count > 0 || other.is_pillar) &&
        other.resolved_path !== null
      )

      // Also find same-group pages
      const sameGroupPages = enriched.filter(other =>
        other.id !== c.id &&
        other.cluster_group === c.cluster_group &&
        other.cluster_group !== null &&
        other.resolved_path !== null
      )

      const suggestions = [...new Map(
        [...sameTopicPages, ...sameGroupPages].map(p => [p.id, p])
      ).values()].slice(0, 5)

      return {
        ...c,
        suggestions: suggestions.map(s => ({
          id:        s.id,
          keyword:   s.keyword,
          url_slug:  s.url_slug,
          is_pillar: s.is_pillar,
          map_topic: s.map_topic,
          cluster_group: s.cluster_group,
        })),
      }
    })
    .sort((a, b) => a.inlinks_count - b.inlinks_count)

  // ── 7. Opportunity detection ────────────────────────────────────────────────
  // For each topic map, find pairs of pages that SHOULD link (same group or pillar↔cluster)
  // but currently don't have a link between them

  type Opportunity = {
    from_keyword:  string
    from_slug:     string
    from_path:     string | null
    from_is_pillar: boolean
    to_keyword:    string
    to_slug:       string
    to_path:       string | null
    to_is_pillar:  boolean
    map_topic:     string
    cluster_group: string | null
    reason:        string   // 'pillar_to_cluster' | 'cluster_to_pillar' | 'intra_group'
  }

  const opportunities: Opportunity[] = []
  const seen = new Set<string>()

  // Group by map
  const byMap = new Map<string, EnrichedCluster[]>()
  for (const c of enriched) {
    if (!byMap.has(c.map_id)) byMap.set(c.map_id, [])
    byMap.get(c.map_id)!.push(c)
  }

  for (const [, mapClusters] of byMap) {
    const pillar     = mapClusters.find(c => c.is_pillar)
    const nonPillars = mapClusters.filter(c => !c.is_pillar && c.resolved_path)

    // Pillar → each cluster (if not already linked)
    if (pillar?.resolved_path) {
      for (const cluster of nonPillars) {
        if (!cluster.resolved_path) continue
        const key = `${pillar.resolved_path}→${cluster.resolved_path}`
        if (seen.has(key)) continue
        const alreadyLinked = linksFromMap.get(pillar.resolved_path)?.has(cluster.resolved_path)
        if (!alreadyLinked) {
          seen.add(key)
          opportunities.push({
            from_keyword: pillar.keyword, from_slug: pillar.url_slug, from_path: pillar.resolved_path, from_is_pillar: true,
            to_keyword:   cluster.keyword, to_slug: cluster.url_slug, to_path: cluster.resolved_path, to_is_pillar: false,
            map_topic:    pillar.map_topic, cluster_group: cluster.cluster_group,
            reason:       'pillar_to_cluster',
          })
        }
      }
    }

    // Cluster → pillar (each cluster should link back to pillar)
    if (pillar?.resolved_path) {
      for (const cluster of nonPillars) {
        if (!cluster.resolved_path) continue
        const key = `${cluster.resolved_path}→${pillar.resolved_path}`
        if (seen.has(key)) continue
        const alreadyLinked = linksFromMap.get(cluster.resolved_path)?.has(pillar.resolved_path)
        if (!alreadyLinked) {
          seen.add(key)
          opportunities.push({
            from_keyword: cluster.keyword, from_slug: cluster.url_slug, from_path: cluster.resolved_path, from_is_pillar: false,
            to_keyword:   pillar.keyword, to_slug: pillar.url_slug, to_path: pillar.resolved_path, to_is_pillar: true,
            map_topic:    pillar.map_topic, cluster_group: cluster.cluster_group,
            reason:       'cluster_to_pillar',
          })
        }
      }
    }

    // Intra-group links (pages in the same cluster_group should link to each other)
    const byGroup = new Map<string, EnrichedCluster[]>()
    for (const c of nonPillars) {
      if (!c.cluster_group || !c.resolved_path) continue
      if (!byGroup.has(c.cluster_group)) byGroup.set(c.cluster_group, [])
      byGroup.get(c.cluster_group)!.push(c)
    }

    for (const [, groupClusters] of byGroup) {
      if (groupClusters.length < 2) continue
      for (let i = 0; i < groupClusters.length; i++) {
        for (let j = i + 1; j < groupClusters.length; j++) {
          const a = groupClusters[i], b = groupClusters[j]
          if (!a.resolved_path || !b.resolved_path) continue
          // Check a → b
          const keyAB = `${a.resolved_path}→${b.resolved_path}`
          if (!seen.has(keyAB) && !linksFromMap.get(a.resolved_path)?.has(b.resolved_path)) {
            seen.add(keyAB)
            opportunities.push({
              from_keyword: a.keyword, from_slug: a.url_slug, from_path: a.resolved_path, from_is_pillar: false,
              to_keyword:   b.keyword, to_slug: b.url_slug, to_path: b.resolved_path, to_is_pillar: false,
              map_topic:    a.map_topic, cluster_group: a.cluster_group,
              reason:       'intra_group',
            })
          }
        }
      }
    }
  }

  // Cap opportunities at 200 (prioritize pillar links first)
  const prioritizedOpps = opportunities
    .sort((a, b) => {
      const order = { pillar_to_cluster: 0, cluster_to_pillar: 1, intra_group: 2 }
      return order[a.reason as keyof typeof order] - order[b.reason as keyof typeof order]
    })
    .slice(0, 200)

  // ── 8. Summary stats ───────────────────────────────────────────────────────
  const summary = {
    totalCrawledPages:   pages.length,
    totalClusters:       enriched.length,
    orphanCount:         orphans.length,
    opportunityCount:    opportunities.length,
    avgInlinks:          enriched.length
      ? Math.round(enriched.reduce((s, c) => s + c.inlinks_count, 0) / enriched.length)
      : 0,
    wellLinked:          enriched.filter(c => c.inlinks_count >= ORPHAN_THRESHOLD).length,
  }

  return NextResponse.json({
    taskId,
    summary,
    orphans,
    opportunities: prioritizedOpps,
    pages: pages.slice(0, 500).map(p => ({
      url:           p.url,
      path:          extractPath(p.url),
      inlinks_count: p.inlinks_count,
      links_internal: p.links_internal,
      status_code:   p.status_code,
      title:         p.meta?.title ?? '',
    })),
  })
}
