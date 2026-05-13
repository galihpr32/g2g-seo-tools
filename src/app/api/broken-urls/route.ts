import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getOnPagePages, getOnPageLinks } from '@/lib/dataforseo/client'

export const maxDuration = 60

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

function normalizePath(url: string): string {
  return extractPath(url).toLowerCase().replace(/\/$/, '') || '/'
}

// ── GET /api/broken-urls ──────────────────────────────────────────────────────
// Returns:
//   broken        — 4xx/5xx pages found in crawl with inbound links + historical GSC loss
//   lostPages     — pages with historical GSC impressions now invisible
//   brokenOutlinks — live pages containing links to broken destinations
//   summary
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // ── 1. Resolve crawl task ─────────────────────────────────────────────────
  const { data: tasks } = await db
    .from('site_audit_tasks')
    .select('task_id, status, target, created_at')
    .eq('owner_user_id', ownerId)
    .eq('status', 'finished')
    .order('created_at', { ascending: false })
    .limit(1)

  const taskId = tasks?.[0]?.task_id ?? null

  // ── 2. GSC OAuth + brand-aware site URL ────────────────────────────────────
  // Sprint 12: site_url comes from site_configs (active slug), NOT
  // gsc_connections.site_url which is single-site per user.
  const { resolveSiteSlugFromRequest } = await import('@/lib/sites')
  const siteSlug = resolveSiteSlugFromRequest(req)
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()
  const { data: brandSiteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .eq('is_active', true)
    .maybeSingle()
  const brandSiteUrl = brandSiteConfig?.gsc_property ?? null

  const hasGSC     = !!(conn?.access_token && brandSiteUrl)
  const hasCrawl   = !!taskId

  if (!hasGSC && !hasCrawl) {
    return NextResponse.json({
      error: 'Neither GSC nor a site audit is available. Connect GSC or run a site audit first.',
      needsSetup: true,
    }, { status: 422 })
  }

  // ── 3. Fetch crawl data (if available) ───────────────────────────────────
  type RawPage = { url: string; status_code: number | null; inlinks_count: number; links_internal: number; title: string }
  type RawLink = { link_from: string; link_to: string; anchor: string | null; dofollow: boolean }

  let allPages: RawPage[] = []
  let allLinks: RawLink[] = []

  if (hasCrawl) {
    const [pages, links] = await Promise.all([
      getOnPagePages(taskId!, 2000),
      getOnPageLinks(taskId!, 10000),
    ])
    allPages = pages.map(p => ({
      url:           p.url,
      status_code:   p.status_code,
      inlinks_count: p.inlinks_count,
      links_internal: p.links_internal,
      title:         p.meta?.title ?? '',
    }))
    allLinks = links
  }

  // ── 4. Fetch GSC data — current vs historical ─────────────────────────────
  type GscEntry = { page: string; clicks: number; impressions: number; position: number }
  let currentGSC:  GscEntry[] = []
  let historicalGSC: GscEntry[] = []

  if (hasGSC) {
    const auth = await getRefreshedClient(conn!.access_token, conn!.refresh_token, conn!.expires_at)
    // GSC API needs YYYY-MM-DD, not GA4-style "7daysAgo"/"yesterday" strings.
    const fmt = (d: Date) => d.toISOString().slice(0, 10)
    const now = Date.now()
    const yest    = fmt(new Date(now - 1  * 86400000))
    const sevenAgo = fmt(new Date(now - 7  * 86400000))
    const sixtyOne = fmt(new Date(now - 61 * 86400000))
    const ninety   = fmt(new Date(now - 90 * 86400000))
    const [curr, hist] = await Promise.all([
      getSearchAnalytics(auth, brandSiteUrl!, sevenAgo, yest, ['page'], 5000).catch(() => []),
      getSearchAnalytics(auth, brandSiteUrl!, ninety,   sixtyOne, ['page'], 5000).catch(() => []),
    ])
    currentGSC  = curr.map(r => ({ page: r.keys?.[0] ?? '', clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, position: r.position ?? 0 })).filter(r => r.page)
    historicalGSC = hist.map(r => ({ page: r.keys?.[0] ?? '', clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, position: r.position ?? 0 })).filter(r => r.page)
  }

  // GSC page sets for fast lookup
  const currentGSCPaths   = new Set(currentGSC.map(r => normalizePath(r.page)))
  const historicalGSCMap  = new Map(historicalGSC.map(r => [normalizePath(r.page), r]))

  // ── 5. Broken pages (4xx/5xx from crawl) ─────────────────────────────────

  // Build: path → inbound links (from link graph)
  const inboundMap = new Map<string, { from: string; anchor: string | null; dofollow: boolean }[]>()
  for (const link of allLinks) {
    const toPath = normalizePath(link.link_to)
    if (!inboundMap.has(toPath)) inboundMap.set(toPath, [])
    inboundMap.get(toPath)!.push({
      from:     link.link_from,
      anchor:   link.anchor,
      dofollow: link.dofollow,
    })
  }

  // Broken pages from crawl: status 4xx or 5xx
  const brokenFromCrawl = allPages
    .filter(p => p.status_code != null && p.status_code >= 400)
    .map(p => {
      const path    = normalizePath(p.url)
      const inlinks = inboundMap.get(path) ?? []
      const hist    = historicalGSCMap.get(path)

      return {
        url:          p.url,
        path,
        status_code:  p.status_code!,
        title:        p.title,
        inlinks_count: inlinks.length,
        inlinks:       inlinks.slice(0, 10),
        // GSC loss data
        historical_impressions: hist?.impressions ?? 0,
        historical_clicks:      hist?.clicks      ?? 0,
        historical_position:    hist?.position    ?? null,
        lost_impressions:       hist?.impressions ?? 0, // now getting 0
        severity: p.status_code! >= 500 ? 'error' as const : 'broken' as const,
      }
    })
    .sort((a, b) => b.historical_impressions - a.historical_impressions)

  // ── 6. Lost pages (GSC historical — now invisible) ────────────────────────
  // Pages that had meaningful impressions 61–90 days ago, now no longer in GSC
  const MIN_HIST_IMPR = 20

  const lostPages = historicalGSC
    .filter(h => {
      if (h.impressions < MIN_HIST_IMPR) return false
      const path = normalizePath(h.page)
      // Not in current GSC
      if (currentGSCPaths.has(path)) return false
      // Not already caught as broken in crawl (avoid duplication)
      const alreadyBroken = brokenFromCrawl.some(b => b.path === path)
      return !alreadyBroken
    })
    .map(h => {
      const path    = normalizePath(h.page)
      const inlinks = inboundMap.get(path) ?? []
      return {
        url:                   h.page,
        path,
        historical_impressions: h.impressions,
        historical_clicks:      h.clicks,
        historical_position:    h.position,
        inlinks_count:          inlinks.length,
        inlinks:                inlinks.slice(0, 5),
        status_code:            null as number | null, // unknown — GSC just stopped seeing it
      }
    })
    .sort((a, b) => b.historical_impressions - a.historical_impressions)
    .slice(0, 200)

  // ── 7. Broken outlinks (live pages → broken destinations) ─────────────────
  // Build set of broken paths from crawl
  const brokenPaths = new Set(brokenFromCrawl.map(b => b.path))

  // Group broken outlinks by source page
  type OutlinkRow = {
    source_url:   string
    source_path:  string
    source_title: string
    broken_links: { dest_url: string; dest_path: string; anchor: string | null; status_code: number | null }[]
  }

  const outlinksBySource = new Map<string, OutlinkRow>()

  for (const link of allLinks) {
    const destPath = normalizePath(link.link_to)
    if (!brokenPaths.has(destPath)) continue

    const srcPath  = normalizePath(link.link_from)
    const srcPage  = allPages.find(p => normalizePath(p.url) === srcPath)
    const destPage = allPages.find(p => normalizePath(p.url) === destPath)

    if (!outlinksBySource.has(srcPath)) {
      outlinksBySource.set(srcPath, {
        source_url:   link.link_from,
        source_path:  srcPath,
        source_title: srcPage?.title ?? srcPath,
        broken_links: [],
      })
    }

    outlinksBySource.get(srcPath)!.broken_links.push({
      dest_url:    link.link_to,
      dest_path:   destPath,
      anchor:      link.anchor,
      status_code: destPage?.status_code ?? null,
    })
  }

  const brokenOutlinks = [...outlinksBySource.values()]
    .sort((a, b) => b.broken_links.length - a.broken_links.length)

  // ── 8. Summary ────────────────────────────────────────────────────────────
  const totalLostImpressions = [
    ...brokenFromCrawl.map(b => b.historical_impressions),
    ...lostPages.map(p => p.historical_impressions),
  ].reduce((s, v) => s + v, 0)

  const summary = {
    hasCrawl,
    hasGSC,
    crawledPages:        allPages.length,
    brokenCount:         brokenFromCrawl.length,
    lostPageCount:       lostPages.length,
    brokenOutlinkPages:  brokenOutlinks.length,
    totalBrokenOutlinks: brokenOutlinks.reduce((s, r) => s + r.broken_links.length, 0),
    totalLostImpressions,
    error5xxCount:       brokenFromCrawl.filter(b => b.status_code >= 500).length,
    error4xxCount:       brokenFromCrawl.filter(b => b.status_code < 500).length,
  }

  return NextResponse.json({ summary, broken: brokenFromCrawl, lostPages, brokenOutlinks })
}
