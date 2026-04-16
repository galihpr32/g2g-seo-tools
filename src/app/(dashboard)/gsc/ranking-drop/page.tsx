import { createClient } from '@/lib/supabase/server'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics, getDateRange, detectRankingDrops, type RankingDrop } from '@/lib/gsc/client'

export const dynamic = 'force-dynamic'

export default async function RankingDropPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: conn } = user
    ? await supabase.from('gsc_connections').select('*').eq('user_id', user.id).single()
    : { data: null }

  let drops: RankingDrop[] = []
  let totalTracked = 0
  let fetchError: string | null = null
  const today = getDateRange(0)

  if (conn?.access_token) {
    try {
      const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const siteUrl = conn.site_url

      // Pull last 7 days vs previous 7 days directly from GSC API
      const [currentRaw, previousRaw] = await Promise.all([
        getSearchAnalytics(auth, siteUrl, getDateRange(7), getDateRange(1)),
        getSearchAnalytics(auth, siteUrl, getDateRange(14), getDateRange(8)),
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
      drops = detectRankingDrops(current, previous)
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
          Data: {today} (live from GSC)
        </span>
      </div>

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ Error fetching GSC data: {fetchError}
        </div>
      )}

      {!conn && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections to connect Google Search Console.</p>
        </div>
      )}

      {conn && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className={`${drops.length > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-900 border-gray-800'} border rounded-xl p-4`}>
              <p className={`text-3xl font-bold ${drops.length > 0 ? 'text-red-400' : 'text-white'}`}>{drops.length}</p>
              <p className="text-gray-400 text-sm mt-1">Pages flagged</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-3xl font-bold text-white">{totalTracked}</p>
              <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-3xl font-bold text-yellow-400">{alerts?.length ?? 0}</p>
              <p className="text-gray-400 text-sm mt-1">Alerts sent (last 5)</p>
            </div>
          </div>

          {drops.length === 0 ? (
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-8 text-center">
              <p className="text-green-400 text-lg font-semibold">✅ No significant drops detected</p>
              <p className="text-gray-400 text-sm mt-1">All tracked pages are within normal range for the past 7 days</p>
            </div>
          ) : (
            <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
              <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
                <p className="text-white font-medium text-sm">
                  {drops.length} page{drops.length !== 1 ? 's' : ''} flagged
                </p>
                <p className="text-gray-500 text-xs">Comparing last 7 days vs previous 7 days</p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Clicks ▼</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Prev</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Drop %</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Impressions ▼</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Position</th>
                    <th className="text-right text-gray-500 font-medium px-5 py-3">Pos Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {drops.map(r => {
                    let path = r.page
                    try { path = new URL(r.page).pathname } catch { /* keep original */ }
                    return (
                      <tr key={r.page} className="hover:bg-gray-800/50 transition">
                        <td className="px-5 py-3 max-w-xs">
                          <a
                            href={r.page}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 truncate block"
                            title={r.page}
                          >
                            {path}
                          </a>
                        </td>
                        <td className="px-5 py-3 text-right text-white">{r.currentClicks.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right text-gray-400">{r.previousClicks.toLocaleString()}</td>
                        <td className={`px-5 py-3 text-right font-semibold ${r.clicksDrop >= 0.15 ? 'text-red-400' : 'text-gray-400'}`}>
                          {r.clicksDrop > 0 ? `-${Math.round(r.clicksDrop * 100)}%` : '—'}
                        </td>
                        <td className={`px-5 py-3 text-right ${r.impressionsDrop >= 0.15 ? 'text-orange-400' : 'text-gray-400'}`}>
                          {r.impressionsDrop > 0 ? `-${Math.round(r.impressionsDrop * 100)}%` : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-gray-300">{r.currentPosition.toFixed(1)}</td>
                        <td className={`px-5 py-3 text-right font-semibold ${r.positionChange >= 5 ? 'text-orange-400' : r.positionChange < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                          {r.positionChange > 0 ? `+${r.positionChange.toFixed(1)}` : r.positionChange.toFixed(1)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Recent alerts log */}
          {alerts && alerts.length > 0 && (
            <div className="mt-8">
              <h2 className="text-white font-semibold mb-3">Recent Alerts</h2>
              <div className="space-y-2">
                {alerts.map((a: { id: string; created_at: string; title: string; severity: string }) => (
                  <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
                    <p className="text-gray-300 text-sm">{a.title}</p>
                    <div className="flex items-center gap-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        a.severity === 'critical' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                      }`}>{a.severity}</span>
                      <span className="text-xs text-gray-500">
                        {new Date(a.created_at).toLocaleDateString('id-ID')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
