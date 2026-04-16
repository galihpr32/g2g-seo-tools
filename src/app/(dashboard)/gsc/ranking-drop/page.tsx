import { createClient } from '@/lib/supabase/server'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics, getDateRange, detectRankingDrops, type RankingDrop } from '@/lib/gsc/client'
import { RankingDropTable } from './RankingDropTable'

export const dynamic = 'force-dynamic'

export type PageDropWithQueries = RankingDrop & {
  queries: {
    query: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }[]
}

export default async function RankingDropPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: conn } = user
    ? await supabase.from('gsc_connections').select('*').eq('user_id', user.id).single()
    : { data: null }

  let drops: PageDropWithQueries[] = []
  let totalTracked = 0
  let fetchError: string | null = null
  const today = getDateRange(0)

  if (conn?.access_token) {
    try {
      const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const siteUrl = conn.site_url

      // Fetch page-level data (for WoW comparison) + query breakdown (for drill-down)
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
      totalTracked = current.length

      const rawDrops = detectRankingDrops(current, previous)

      // Build query map: page → top queries
      const queryMap = new Map<string, PageDropWithQueries['queries']>()
      for (const row of queryRaw) {
        const page = row.keys?.[0] ?? ''
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

      // Sort queries by clicks desc, keep top 20 per page
      for (const [page, queries] of queryMap.entries()) {
        queryMap.set(page, queries.sort((a, b) => b.clicks - a.clicks).slice(0, 20))
      }

      drops = rawDrops.map(drop => ({
        ...drop,
        queries: queryMap.get(drop.page) ?? [],
      }))
    } catch (e) {
      fetchError = String(e)
    }
  }

  const { data: alerts } = await supabase
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'ranking_drop')
    .order('created_at', { ascending: false })
    .limit(5)

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📉 Ranking Drop Alert</h1>
          <p className="text-gray-400 text-sm mt-1">Pages with &gt;15% WoW drop in clicks or position change ≥5</p>
        </div>
        <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">
          {today} · live from GSC
        </span>
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
        />
      )}
    </div>
  )
}
