import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function OrganicTrafficPage() {
  const supabase = await createClient()

  const { data: snapshots } = await supabase
    .from('ga4_organic_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(7)

  const latest = snapshots?.[0]
  const previous = snapshots?.[1]

  const sessionsDiff = latest && previous
    ? ((latest.sessions - previous.sessions) / previous.sessions) * 100
    : null

  const engagementRate = latest
    ? ((latest.engaged_sessions / latest.sessions) * 100).toFixed(1)
    : null

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📈 Organic Traffic Analysis</h1>
          <p className="text-gray-400 text-sm mt-1">Weekly GA4 organic sessions, engagement rate and top landing pages</p>
        </div>
        {latest && <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">Week of {latest.snapshot_date}</span>}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Organic Sessions</p>
          <p className="text-3xl font-bold text-white">{latest?.sessions?.toLocaleString() ?? '—'}</p>
          {sessionsDiff !== null && (
            <p className={`text-sm mt-1 font-medium ${sessionsDiff < 0 ? 'text-red-400' : 'text-green-400'}`}>
              {sessionsDiff > 0 ? '+' : ''}{sessionsDiff.toFixed(1)}% WoW
            </p>
          )}
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Engagement Rate</p>
          <p className="text-3xl font-bold text-white">{engagementRate ? `${engagementRate}%` : '—'}</p>
          <p className="text-sm mt-1 text-gray-500">engaged sessions</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Page Views</p>
          <p className="text-3xl font-bold text-white">{latest?.page_views?.toLocaleString() ?? '—'}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Bounce Rate</p>
          <p className={`text-3xl font-bold ${(latest?.bounce_rate ?? 0) > 0.6 ? 'text-red-400' : 'text-white'}`}>
            {latest?.bounce_rate ? `${(latest.bounce_rate * 100).toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>

      {/* 7-day trend */}
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
            {!snapshots?.length ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  No data yet — will populate after first cron run
                </td>
              </tr>
            ) : snapshots.map((snap, i) => (
              <tr key={snap.id} className={`hover:bg-gray-800/50 transition ${i === 0 ? 'bg-blue-900/10' : ''}`}>
                <td className="px-5 py-3 text-gray-300">{snap.snapshot_date} {i === 0 && <span className="text-xs text-blue-400 ml-2">latest</span>}</td>
                <td className="px-5 py-3 text-right text-white">{snap.sessions?.toLocaleString()}</td>
                <td className="px-5 py-3 text-right text-gray-300">{snap.engaged_sessions?.toLocaleString()}</td>
                <td className="px-5 py-3 text-right text-gray-300">{snap.page_views?.toLocaleString()}</td>
                <td className={`px-5 py-3 text-right ${snap.bounce_rate > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                  {(snap.bounce_rate * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Top pages */}
      {latest?.top_pages && (
        <>
          <h2 className="text-white font-semibold mb-3">Top Landing Pages</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Engaged</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Bounce</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {(latest.top_pages as { path: string; sessions: number; engaged: number; bounce: number }[]).map((p, i) => (
                  <tr key={i} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3 text-blue-400 max-w-xs truncate">{p.path}</td>
                    <td className="px-5 py-3 text-right text-white">{p.sessions?.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{p.engaged?.toLocaleString()}</td>
                    <td className={`px-5 py-3 text-right ${p.bounce > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                      {(p.bounce * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
