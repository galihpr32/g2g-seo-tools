import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4OrganicTraffic, parseGA4Rows, sumMetric } from '@/lib/ga4/client'

export const dynamic = 'force-dynamic'

export default async function OrganicTrafficPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  const { data: conn } = effectiveOwnerId
    ? await supabase.from('gsc_connections').select('*').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  const propertyId = process.env.GA4_PROPERTY_ID
  const today = new Date().toISOString().split('T')[0]

  let thisWeekRows: Record<string, string>[] = []
  let lastWeekRows: Record<string, string>[] = []
  let topPagesRows: Record<string, string>[] = []
  let fetchError: string | null = null
  let dataSource: 'live' | 'none' = 'none'

  if (conn?.access_token && propertyId) {
    try {
      const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const data = await getGA4OrganicTraffic(auth, propertyId)
      thisWeekRows = parseGA4Rows(data.thisWeek)
      lastWeekRows = parseGA4Rows(data.lastWeek)
      topPagesRows = parseGA4Rows(data.topPages)
      dataSource = 'live'
    } catch (e) {
      fetchError = String(e)
    }
  }

  // ── Aggregate totals ─────────────────────────────────────────────────────
  const sessions = sumMetric(thisWeekRows, 'sessions')
  const prevSessions = sumMetric(lastWeekRows, 'sessions')
  const engagedSessions = sumMetric(thisWeekRows, 'engagedSessions')
  const pageViews = sumMetric(thisWeekRows, 'screenPageViews')
  const avgBounce = thisWeekRows.length > 0
    ? thisWeekRows.reduce((s, r) => s + parseFloat(r.bounceRate ?? '0'), 0) / thisWeekRows.length
    : 0

  const sessionsDiff = prevSessions > 0 ? ((sessions - prevSessions) / prevSessions) * 100 : null
  const engagementRate = sessions > 0 ? (engagedSessions / sessions) * 100 : 0

  // Sort daily rows by date asc for trend table
  const dailyRows = [...thisWeekRows].sort((a, b) =>
    (a.date ?? '').localeCompare(b.date ?? '')
  )

  // Filter top pages to organic only
  const organicPages = topPagesRows
    .filter(r => (r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic'))
    .slice(0, 20)

  const notConfigured = !propertyId || !conn?.access_token

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📈 Organic Traffic Analysis</h1>
          <p className="text-gray-400 text-sm mt-1">Weekly GA4 organic sessions, engagement rate and top landing pages</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">{today}</span>
          {dataSource === 'live' && (
            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2.5 py-1 rounded-full">🔄 live</span>
          )}
        </div>
      </div>

      {notConfigured && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6 mb-6">
          <p className="text-yellow-400 font-medium">GA4 not fully configured</p>
          <p className="text-gray-400 text-sm mt-1">
            {!propertyId ? 'Add GA4_PROPERTY_ID to Vercel env.' : 'Reconnect Google in Settings to grant Analytics access.'}
          </p>
        </div>
      )}

      {fetchError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm text-red-400">
          ⚠️ {fetchError}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Organic Sessions</p>
          <p className="text-3xl font-bold text-white">{sessions > 0 ? sessions.toLocaleString() : '—'}</p>
          {sessionsDiff !== null && (
            <p className={`text-sm mt-1 font-medium ${sessionsDiff < 0 ? 'text-red-400' : 'text-green-400'}`}>
              {sessionsDiff > 0 ? '+' : ''}{sessionsDiff.toFixed(1)}% WoW
            </p>
          )}
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Engagement Rate</p>
          <p className="text-3xl font-bold text-white">{engagementRate > 0 ? `${engagementRate.toFixed(1)}%` : '—'}</p>
          <p className="text-xs mt-1 text-gray-500">{engagedSessions > 0 ? `${engagedSessions.toLocaleString()} engaged` : 'engaged sessions'}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Page Views</p>
          <p className="text-3xl font-bold text-white">{pageViews > 0 ? pageViews.toLocaleString() : '—'}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Bounce Rate</p>
          <p className={`text-3xl font-bold ${avgBounce > 0.6 ? 'text-red-400' : 'text-white'}`}>
            {avgBounce > 0 ? `${(avgBounce * 100).toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* 7-Day Trend */}
      <h2 className="text-white font-semibold mb-3">7-Day Trend</h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Engaged</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Page Views</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Bounce Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {dailyRows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  {notConfigured ? 'Configure GA4 to see data' : 'No data available'}
                </td>
              </tr>
            ) : dailyRows.map((row, i) => {
              const dateStr = row.date ? `${row.date.slice(0,4)}-${row.date.slice(4,6)}-${row.date.slice(6,8)}` : '—'
              const bounce = parseFloat(row.bounceRate ?? '0')
              return (
                <tr key={i} className={`hover:bg-gray-800/50 transition ${i === dailyRows.length - 1 ? 'bg-blue-900/10' : ''}`}>
                  <td className="px-5 py-3 text-gray-300">
                    {dateStr}
                    {i === dailyRows.length - 1 && <span className="text-xs text-blue-400 ml-2">latest</span>}
                  </td>
                  <td className="px-5 py-3 text-right text-white">{parseInt(row.sessions ?? '0').toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{parseInt(row.engagedSessions ?? '0').toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{parseInt(row.screenPageViews ?? '0').toLocaleString()}</td>
                  <td className={`px-5 py-3 text-right ${bounce > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                    {(bounce * 100).toFixed(1)}%
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Top organic landing pages */}
      <h2 className="text-white font-semibold mb-3">
        Top Organic Landing Pages
        <span className="text-gray-500 font-normal text-sm ml-2">(last 7 days)</span>
      </h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Engaged</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Bounce</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Conversions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {organicPages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  {dataSource === 'live' ? 'No organic landing page data found' : 'Configure GA4 to see data'}
                </td>
              </tr>
            ) : organicPages.map((p, i) => {
              const bounce = parseFloat(p.bounceRate ?? '0')
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate" title={p.pagePath}>{p.pagePath}</td>
                  <td className="px-5 py-3 text-right text-white">{parseInt(p.sessions ?? '0').toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{parseInt(p.engagedSessions ?? '0').toLocaleString()}</td>
                  <td className={`px-5 py-3 text-right ${bounce > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                    {(bounce * 100).toFixed(1)}%
                  </td>
                  <td className="px-5 py-3 text-right text-gray-300">{parseInt(p.conversions ?? '0').toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
