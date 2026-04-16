import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function IndexCoveragePage() {
  const supabase = await createClient()

  const { data: snapshots } = await supabase
    .from('gsc_index_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(14)

  const latest = snapshots?.[0]
  const previous = snapshots?.[1]

  const indexDiff = latest && previous ? latest.indexed_pages - previous.indexed_pages : null
  const { data: alerts } = await supabase
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'index_coverage')
    .order('created_at', { ascending: false })
    .limit(5)

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔍 Index Coverage Check</h1>
        <p className="text-gray-400 text-sm mt-1">Daily monitoring of indexed pages and crawl errors</p>
      </div>

      {/* Current status */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Indexed Pages</p>
          <p className="text-3xl font-bold text-white">{latest?.indexed_pages?.toLocaleString() ?? '—'}</p>
          {indexDiff !== null && (
            <p className={`text-sm mt-1 font-medium ${indexDiff < -50 ? 'text-red-400' : indexDiff > 0 ? 'text-green-400' : 'text-gray-500'}`}>
              {indexDiff > 0 ? `+${indexDiff}` : indexDiff} vs yesterday
            </p>
          )}
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Crawl Errors</p>
          <p className={`text-3xl font-bold ${(latest?.errors ?? 0) > 0 ? 'text-red-400' : 'text-green-400'}`}>
            {latest?.errors ?? 0}
          </p>
          <p className="text-sm mt-1 text-gray-500">detected today</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Status</p>
          <p className={`text-lg font-bold mt-1 ${indexDiff !== null && indexDiff < -50 ? 'text-red-400' : 'text-green-400'}`}>
            {indexDiff !== null && indexDiff < -50 ? '⚠️ Drop Detected' : '✅ Normal'}
          </p>
        </div>
      </div>

      {/* 14-day trend */}
      <h2 className="text-white font-semibold mb-3">14-Day Trend</h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Indexed Pages</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Errors</th>
              <th className="text-right text-gray-500 font-medium px-5 py-3">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(snapshots ?? []).map((snap, i) => {
              const prev = snapshots?.[i + 1]
              const diff = prev ? snap.indexed_pages - prev.indexed_pages : null
              return (
                <tr key={snap.id} className={`hover:bg-gray-800/50 transition ${i === 0 ? 'bg-blue-900/10' : ''}`}>
                  <td className="px-5 py-3 text-gray-300">{snap.snapshot_date} {i === 0 && <span className="text-xs text-blue-400 ml-2">latest</span>}</td>
                  <td className="px-5 py-3 text-right text-white">{snap.indexed_pages?.toLocaleString()}</td>
                  <td className={`px-5 py-3 text-right ${snap.errors > 0 ? 'text-red-400' : 'text-gray-400'}`}>{snap.errors}</td>
                  <td className={`px-5 py-3 text-right font-medium ${diff === null ? 'text-gray-500' : diff < -50 ? 'text-red-400' : diff > 0 ? 'text-green-400' : 'text-gray-400'}`}>
                    {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Alert log */}
      {alerts && alerts.length > 0 && (
        <>
          <h2 className="text-white font-semibold mb-3">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                <p className="text-red-400 font-medium text-sm">{a.title}</p>
                <p className="text-gray-400 text-xs mt-0.5">{new Date(a.created_at).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
