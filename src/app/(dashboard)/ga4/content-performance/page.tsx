import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function ContentPerformancePage() {
  const supabase = await createClient()

  const { data: snapshots } = await supabase
    .from('ga4_content_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(2)

  const current = snapshots?.[0]
  const previous = snapshots?.[1]

  type PageData = { path: string; sessions: number; engaged: number; bounce: number; views: number; avgDuration: number }

  const currentPages: PageData[] = current?.pages ?? []
  const previousPages: PageData[] = previous?.pages ?? []
  const prevMap = new Map(previousPages.map((p: PageData) => [p.path, p]))

  // Find decaying pages (sessions dropped >20% MoM)
  const decaying = currentPages
    .map((p: PageData) => {
      const prev = prevMap.get(p.path)
      if (!prev || prev.sessions === 0) return null
      const drop = (prev.sessions - p.sessions) / prev.sessions
      return drop >= 0.2 ? { ...p, drop, prevSessions: prev.sessions } : null
    })
    .filter(Boolean)
    .sort((a, b) => (b?.drop ?? 0) - (a?.drop ?? 0))

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">📄 Content Performance Audit</h1>
        <p className="text-gray-400 text-sm mt-1">Monthly analysis — pages losing traffic flagged for refresh or consolidation</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5">
          <p className="text-3xl font-bold text-red-400">{decaying.length}</p>
          <p className="text-gray-400 text-sm mt-1">Decaying pages (&gt;20% drop)</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-3xl font-bold text-white">{currentPages.length}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-3xl font-bold text-green-400">
            {currentPages.filter((p: PageData) => {
              const prev = prevMap.get(p.path)
              return prev && p.sessions > prev.sessions
            }).length}
          </p>
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
            {!decaying.length ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  {currentPages.length ? '✅ No decaying content detected this month' : 'No data yet — will populate after first cron run'}
                </td>
              </tr>
            ) : decaying.map((p, i) => {
              if (!p) return null
              const action = p.drop >= 0.5 ? 'Redirect or consolidate' : p.drop >= 0.3 ? 'Full refresh needed' : 'Update & re-promote'
              const actionColor = p.drop >= 0.5 ? 'text-red-400' : p.drop >= 0.3 ? 'text-orange-400' : 'text-yellow-400'
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate">{p.path}</td>
                  <td className="px-5 py-3 text-right text-white">{p.sessions?.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{p.prevSessions?.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-red-400 font-semibold">-{Math.round(p.drop * 100)}%</td>
                  <td className={`px-5 py-3 font-medium ${actionColor}`}>{action}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

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
            {!currentPages.length ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">No data yet</td>
              </tr>
            ) : currentPages.map((p: PageData, i: number) => {
              const prev = prevMap.get(p.path)
              const mom = prev && prev.sessions > 0
                ? ((p.sessions - prev.sessions) / prev.sessions) * 100
                : null
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate">{p.path}</td>
                  <td className="px-5 py-3 text-right text-white">{p.sessions?.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{p.views?.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{Math.round(p.avgDuration ?? 0)}s</td>
                  <td className={`px-5 py-3 text-right font-medium ${mom === null ? 'text-gray-500' : mom < -20 ? 'text-red-400' : mom > 0 ? 'text-green-400' : 'text-gray-400'}`}>
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
