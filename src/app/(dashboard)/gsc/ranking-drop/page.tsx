import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function RankingDropPage() {
  const supabase = await createClient()

  // Latest snapshot date
  const { data: latestDate } = await supabase
    .from('gsc_ranking_snapshots')
    .select('snapshot_date')
    .order('snapshot_date', { ascending: false })
    .limit(1)
    .single()

  const date = latestDate?.snapshot_date

  // Current week rankings
  const { data: current } = await supabase
    .from('gsc_ranking_snapshots')
    .select('*')
    .eq('snapshot_date', date ?? '')
    .order('clicks', { ascending: false })
    .limit(100)

  // Previous week rankings
  const prevDate = date
    ? new Date(new Date(date).getTime() - 7 * 86400000).toISOString().split('T')[0]
    : null

  const { data: previous } = await supabase
    .from('gsc_ranking_snapshots')
    .select('*')
    .eq('snapshot_date', prevDate ?? '')

  const prevMap = new Map(previous?.map(r => [r.page, r]) ?? [])

  // Recent alerts
  const { data: alerts } = await supabase
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'ranking_drop')
    .order('created_at', { ascending: false })
    .limit(5)

  const rows = (current ?? []).map(curr => {
    const prev = prevMap.get(curr.page)
    const clicksDrop = prev && prev.clicks > 0 ? (prev.clicks - curr.clicks) / prev.clicks : 0
    const posDiff = prev ? curr.position - prev.position : 0
    return { ...curr, clicksDrop, posDiff, prev }
  }).filter(r => r.clicksDrop >= 0.15 || r.posDiff >= 5)

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">📉 Ranking Drop Alert</h1>
          <p className="text-gray-400 text-sm mt-1">Pages with &gt;15% WoW drop in clicks or position change ≥5</p>
        </div>
        {date && <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">Data: {date}</span>}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <p className="text-3xl font-bold text-red-400">{rows.length}</p>
          <p className="text-gray-400 text-sm mt-1">Pages flagged</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-white">{current?.length ?? 0}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-yellow-400">{alerts?.length ?? 0}</p>
          <p className="text-gray-400 text-sm mt-1">Alerts sent (last 5)</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-8 text-center">
          <p className="text-green-400 text-lg font-semibold">✅ No significant drops detected</p>
          <p className="text-gray-400 text-sm mt-1">All tracked pages are within normal range</p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Clicks (now)</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Clicks (prev)</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Drop</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Position</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Pos. Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {rows.map(r => (
                <tr key={r.page} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate">
                    {new URL(r.page).pathname}
                  </td>
                  <td className="px-5 py-3 text-right text-white">{r.clicks.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-400">{r.prev?.clicks?.toLocaleString() ?? '—'}</td>
                  <td className={`px-5 py-3 text-right font-semibold ${r.clicksDrop >= 0.15 ? 'text-red-400' : 'text-gray-400'}`}>
                    {r.clicksDrop > 0 ? `-${Math.round(r.clicksDrop * 100)}%` : '—'}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-300">{r.position.toFixed(1)}</td>
                  <td className={`px-5 py-3 text-right font-semibold ${r.posDiff >= 5 ? 'text-orange-400' : r.posDiff < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                    {r.posDiff > 0 ? `+${r.posDiff.toFixed(1)}` : r.posDiff.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
