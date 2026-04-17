import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4ContentPerformance, parseGA4Rows } from '@/lib/ga4/client'

export const dynamic = 'force-dynamic'

export default async function ContentPerformancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  const { data: conn } = effectiveOwnerId
    ? await supabase.from('gsc_connections').select('*').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  const propertyId = process.env.GA4_PROPERTY_ID
  const today = new Date().toISOString().split('T')[0]

  type PageData = {
    path: string
    sessions: number
    engaged: number
    bounce: number
    views: number
    avgDuration: number
    prevSessions?: number
    drop?: number
  }

  let currentPages: PageData[] = []
  let prevMap = new Map<string, PageData>()
  let fetchError: string | null = null
  let dataSource: 'live' | 'none' = 'none'

  const notConfigured = !propertyId || !conn?.access_token

  if (conn?.access_token && propertyId) {
    try {
      const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const data = await getGA4ContentPerformance(auth, propertyId)

      const thisRows = parseGA4Rows(data.thisMonth)
      const prevRows = parseGA4Rows(data.lastMonth)

      currentPages = thisRows.map(r => ({
        path: r.pagePath ?? '',
        sessions: parseInt(r.sessions ?? '0'),
        engaged: parseInt(r.engagedSessions ?? '0'),
        bounce: parseFloat(r.bounceRate ?? '0'),
        views: parseInt(r.screenPageViews ?? '0'),
        avgDuration: parseFloat(r.averageSessionDuration ?? '0'),
      })).filter(p => p.path)

      prevMap = new Map(
        prevRows.map(r => [r.pagePath ?? '', {
          path: r.pagePath ?? '',
          sessions: parseInt(r.sessions ?? '0'),
          engaged: parseInt(r.engagedSessions ?? '0'),
          bounce: parseFloat(r.bounceRate ?? '0'),
          views: parseInt(r.screenPageViews ?? '0'),
          avgDuration: parseFloat(r.averageSessionDuration ?? '0'),
        }])
      )

      dataSource = 'live'
    } catch (e) {
      fetchError = String(e)
    }
  }

  // Decaying: >20% session drop MoM
  const decaying: (PageData & { prevSessions: number; drop: number })[] = currentPages
    .map(p => {
      const prev = prevMap.get(p.path)
      if (!prev || prev.sessions === 0) return null
      const drop = (prev.sessions - p.sessions) / prev.sessions
      return drop >= 0.2 ? { ...p, prevSessions: prev.sessions, drop } : null
    })
    .filter((x): x is PageData & { prevSessions: number; drop: number } => x !== null)
    .sort((a, b) => b.drop - a.drop)

  // Growing: >10% session gain MoM
  const growing = currentPages
    .map(p => {
      const prev = prevMap.get(p.path)
      if (!prev || prev.sessions === 0) return null
      const gain = (p.sessions - prev.sessions) / prev.sessions
      return gain >= 0.1 ? { ...p, prevSessions: prev.sessions, gain } : null
    })
    .filter(Boolean)
    .sort((a, b) => (b?.gain ?? 0) - (a?.gain ?? 0))
    .slice(0, 10)

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📄 Content Performance Audit</h1>
          <p className="text-gray-400 text-sm mt-1">30-day analysis — decaying pages flagged for refresh or consolidation</p>
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

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className={`${decaying.length > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-900 border-gray-800'} border rounded-xl p-5`}>
          <p className={`text-3xl font-bold ${decaying.length > 0 ? 'text-red-400' : 'text-white'}`}>{decaying.length}</p>
          <p className="text-gray-400 text-sm mt-1">Decaying pages (&gt;20% drop)</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-3xl font-bold text-white">{currentPages.length}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5">
          <p className="text-3xl font-bold text-green-400">{growing.length}</p>
          <p className="text-gray-400 text-sm mt-1">Pages growing MoM</p>
        </div>
      </div>

      {/* Decaying pages */}
      <h2 className="text-white font-semibold mb-3">🔴 Decaying Content — Action Required</h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (now)</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (prev)</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Drop</th>
              <th className="text-left text-gray-500 font-medium px-5 py-3">Recommendation</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {decaying.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  {dataSource === 'live' ? '✅ No decaying content detected this month' : 'Configure GA4 to see data'}
                </td>
              </tr>
            ) : decaying.map((p, i) => {
              const action = p.drop >= 0.5 ? 'Redirect or consolidate' : p.drop >= 0.3 ? 'Full refresh needed' : 'Update & re-promote'
              const actionColor = p.drop >= 0.5 ? 'text-red-400' : p.drop >= 0.3 ? 'text-orange-400' : 'text-yellow-400'
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate" title={p.path}>{p.path}</td>
                  <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{p.prevSessions.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-red-400 font-semibold">-{Math.round(p.drop * 100)}%</td>
                  <td className={`px-5 py-3 font-medium ${actionColor}`}>{action}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Growing pages */}
      {growing.length > 0 && (
        <>
          <h2 className="text-white font-semibold mb-3">🟢 Growing Pages — Momentum to Amplify</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (now)</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (prev)</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Growth</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {growing.map((p, i) => {
                  if (!p) return null
                  return (
                    <tr key={i} className="hover:bg-gray-800/50 transition">
                      <td className="px-5 py-3 text-blue-400 max-w-xs truncate" title={p.path}>{p.path}</td>
                      <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-400">{p.prevSessions?.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-green-400 font-semibold">
                        +{Math.round((p.gain ?? 0) * 100)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* All pages */}
      <h2 className="text-white font-semibold mb-3">All Tracked Pages (Top 50)</h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Views</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Avg Duration</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">MoM</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {currentPages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  {dataSource === 'live' ? 'No page data found' : 'Configure GA4 to see data'}
                </td>
              </tr>
            ) : currentPages.map((p, i) => {
              const prev = prevMap.get(p.path)
              const mom = prev && prev.sessions > 0
                ? ((p.sessions - prev.sessions) / prev.sessions) * 100
                : null
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate" title={p.path}>{p.path}</td>
                  <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{p.views.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{Math.round(p.avgDuration)}s</td>
                  <td className={`px-5 py-3 text-right font-medium ${
                    mom === null ? 'text-gray-500' : mom < -20 ? 'text-red-400' : mom > 10 ? 'text-green-400' : 'text-gray-400'
                  }`}>
                    {mom === null ? '—' : `${mom > 0 ? '+' : ''}${mom.toFixed(1)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
