import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getActiveSiteSlug } from '@/lib/sites'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics, getDateRange, detectRankingDrops } from '@/lib/gsc/client'
import { RankingDropTable } from './RankingDropTable'
import type { PageDropWithQueries } from './RankingDropTable'
import MimirPanel from '@/components/agents/MimirPanel'

export const revalidate = 1800

// ── URL pre-filter — only fetch query data for relevant pages ─────────────────
// Change these to adjust which pages are tracked (applies to UI defaults + alerts)
const URL_INCLUDE = ['/categories/'] // page must contain one of these
const URL_EXCLUDE = ['/offer/']      // page must NOT contain any of these

function isRelevantPage(url: string) {
  const p = url.toLowerCase()
  if (URL_INCLUDE.length > 0 && !URL_INCLUDE.some(inc => p.includes(inc))) return false
  if (URL_EXCLUDE.some(ex => p.includes(ex))) return false
  return true
}

export default async function RankingDropPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null

  // Multi-brand-safe site resolution. Use active slug → site_configs.gsc_property
  // for the site_url filter. gsc_connections is still used for OAuth tokens
  // (one set of tokens per user can read multiple GSC properties under that
  // Google account), but the SITE we filter for comes from the active slug.
  const activeSlug = await getActiveSiteSlug()
  const db = createServiceClient()
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', activeSlug)
    .eq('is_active', true)
    .maybeSingle()
  const { data: rawConn } = effectiveOwnerId
    ? await supabase.from('gsc_connections').select('*').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  // Override conn.site_url with the active site's gsc_property so all
  // downstream filters scope correctly. If the user has no GSC connection
  // OR the active site isn't configured, conn=null → empty page (never
  // fall back to a different brand).
  const conn = (rawConn && siteConfig?.gsc_property)
    ? { ...rawConn, site_url: siteConfig.gsc_property }
    : null

  let drops: PageDropWithQueries[] = []
  let totalTracked = 0
  let fetchError: string | null = null
  let dataSource: 'db' | 'live' | 'none' = 'none'
  const today = getDateRange(0)

  if (conn) {
    // ── Step 1: Try reading today's drops from DB (fast, no API call) ────
    const { data: dbDrops } = await supabase
      .from('gsc_ranking_drops')
      .select('*')
      .eq('site_url', conn.site_url)
      .eq('snapshot_date', today)
      .order('clicks_drop', { ascending: false })

    const { data: snapshot } = await supabase
      .from('gsc_ranking_snapshots')
      .select('page')
      .eq('site_url', conn.site_url)
      .eq('snapshot_date', today)

    if (snapshot?.length) totalTracked = snapshot.length

    if (dbDrops && dbDrops.length > 0) {
      // Drops exist in DB — load queries from DB too
      dataSource = 'db'

      const pages = dbDrops.map(d => d.page)
      const { data: dbQueries } = await supabase
        .from('gsc_ranking_drop_queries')
        .select('*')
        .eq('site_url', conn.site_url)
        .eq('snapshot_date', today)
        .in('page', pages)
        .order('clicks', { ascending: false })

      const queryMap = new Map<string, PageDropWithQueries['queries']>()
      for (const q of dbQueries ?? []) {
        if (!queryMap.has(q.page)) queryMap.set(q.page, [])
        queryMap.get(q.page)!.push({
          query: q.query,
          clicks: q.clicks,
          impressions: q.impressions,
          ctr: q.ctr,
          position: q.position,
        })
      }

      drops = dbDrops.map(d => ({
        page: d.page,
        currentClicks: d.clicks_now,
        previousClicks: d.clicks_prev,
        clicksDrop: d.clicks_drop,
        currentImpressions: d.impressions_now,
        previousImpressions: d.impressions_prev,
        impressionsDrop: d.impressions_drop,
        currentPosition: d.position_now,
        previousPosition: d.position_prev,
        positionChange: d.position_diff,
        queries: queryMap.get(d.page) ?? [],
      }))
    } else if (conn.access_token) {
      // ── Step 2: No DB data yet — fetch live from GSC API ─────────────
      dataSource = 'live'
      try {
        const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
        const siteUrl = conn.site_url

        const [currentRaw, previousRaw, queryRaw] = await Promise.all([
          getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1), ['page'], 1000),
          getSearchAnalytics(auth, siteUrl, getDateRange(14), getDateRange(8), ['page'], 1000),
          getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1), ['page', 'query'], 2000),
        ])

        const toRow = (rows: typeof currentRaw) => rows.map(r => ({
          page: r.keys?.[0] ?? '',
          clicks: r.clicks ?? 0,
          impressions: r.impressions ?? 0,
          ctr: r.ctr ?? 0,
          position: r.position ?? 0,
        }))

        const current = toRow(currentRaw)
        const previous = toRow(previousRaw)
        if (!totalTracked) totalTracked = current.length

        const rawDrops = detectRankingDrops(current, previous)

        // Pre-filter before fetching queries — saves API calls for irrelevant pages
        const relevantDrops = rawDrops.filter(d => isRelevantPage(d.page))

        // Build query map only from pre-filtered pages
        const relevantPages = new Set(relevantDrops.map(d => d.page))
        const queryMap = new Map<string, PageDropWithQueries['queries']>()
        for (const row of queryRaw) {
          const page = row.keys?.[0] ?? ''
          if (!relevantPages.has(page)) continue // skip irrelevant pages
          const query = row.keys?.[1] ?? ''
          if (!queryMap.has(page)) queryMap.set(page, [])
          queryMap.get(page)!.push({
            query,
            clicks: row.clicks ?? 0,
            impressions: row.impressions ?? 0,
            ctr: row.ctr ?? 0,
            position: row.position ?? 0,
          })
        }
        for (const [p, qs] of queryMap) {
          queryMap.set(p, qs.sort((a, b) => b.clicks - a.clicks).slice(0, 20))
        }

        drops = relevantDrops.map(d => ({
          ...d,
          queries: queryMap.get(d.page) ?? [],
        }))
      } catch (e) {
        fetchError = String(e)
      }
    }
  }

  const { data: alerts } = await supabase
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'ranking_drop')
    .order('created_at', { ascending: false })
    .limit(5)

  /**
   * Pull the latest Heimdall analysis for each page currently shown in the
   * table. Heimdall writes a `drop_analysis` finding (in agent_findings) for
   * every significant drop it detects on each run — we surface its verdict
   * inline next to each row so users get "what does Heimdall think this is?"
   * without having to dig into action items.
   *
   * Multiple findings per page accumulate over runs; we keep only the most
   * recent per (subject = page URL).
   */
  const heimdallByPage: Record<string, {
    category:       'algorithmic' | 'technical' | 'content' | 'unknown'
    severity:       'high' | 'medium' | 'low' | 'info' | null
    reasoning:      string
    recommendation: string
    analyzed_at:    string
  }> = {}
  if (drops.length > 0 && effectiveOwnerId) {
    const pagesShown = drops.map(d => d.page)
    const { data: heimFindings } = await supabase
      .from('agent_findings')
      .select('subject, severity, data, observed_at')
      .eq('owner_user_id', effectiveOwnerId)
      .eq('agent_key', 'heimdall')
      .eq('finding_type', 'drop_analysis')
      .in('subject', pagesShown)
      .order('observed_at', { ascending: false })
      .limit(500)

    for (const f of heimFindings ?? []) {
      const subj = String(f.subject ?? '')
      if (!subj || heimdallByPage[subj]) continue   // first wins (DESC = latest)
      const d = (f.data ?? {}) as { category?: string; reasoning?: string; recommendation?: string }
      heimdallByPage[subj] = {
        category:       (d.category as 'algorithmic' | 'technical' | 'content' | 'unknown') ?? 'unknown',
        severity:       (f.severity as 'high' | 'medium' | 'low' | 'info' | null) ?? null,
        reasoning:      String(d.reasoning ?? ''),
        recommendation: String(d.recommendation ?? ''),
        analyzed_at:    String(f.observed_at),
      }
    }
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📉 Clicks Drop Alert</h1>
          <p className="text-gray-400 text-sm mt-1">Pages with &gt;15% week-over-week drop in organic clicks</p>
        </div>
        <div className="flex items-center gap-2">
          <MimirPanel
            pageContext={{ kind: 'ranking_drops' }}
            trigger="🪶 Ask Mimir"
          />
          <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">
            {today}
          </span>
          {dataSource === 'db' && (
            <span className="text-xs text-green-600 bg-green-500/10 border border-green-500/20 px-2.5 py-1 rounded-full">
              ⚡ from DB
            </span>
          )}
          {dataSource === 'live' && (
            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-full">
              🔄 live
            </span>
          )}
        </div>
      </div>

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ Error fetching GSC data: {fetchError}
        </div>
      )}

      {!conn ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections to connect Google Search Console.</p>
        </div>
      ) : (
        <RankingDropTable
          drops={drops}
          totalTracked={totalTracked}
          alerts={alerts ?? []}
          snapshotDate={today}
          siteUrl={conn.site_url}
          heimdallByPage={heimdallByPage}
        />
      )}
    </div>
  )
}
