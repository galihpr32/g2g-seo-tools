import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const revalidate = 3600

export default async function IndexCoveragePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  // Use service client so workspace members can read owner's snapshots (bypasses RLS)
  const db = createServiceClient()

  const { data: conn } = effectiveOwnerId
    ? await db.from('gsc_connections').select('site_url').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  const siteUrl = conn?.site_url

  const { data: snapshots } = siteUrl
    ? await db
        .from('gsc_index_snapshots')
        .select('*')
        .eq('site_url', siteUrl)
        .order('snapshot_date', { ascending: false })
        .limit(14)
    : { data: [] }

  const { data: alerts } = await db
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'index_coverage')
    .order('created_at', { ascending: false })
    .limit(5)

  const latest = snapshots?.[0]
  const previous = snapshots?.[1]
  const indexDiff = latest && previous ? latest.indexed_pages - previous.indexed_pages : null

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🔍 Index Coverage Check</h1>
          <p className="text-gray-400 text-sm mt-1">Daily monitoring of indexed pages and crawl errors</p>
        </div>
        {siteUrl && (
          <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full truncate max-w-xs">
            {siteUrl}
          </span>
        )}
      </div>

      {!conn && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections to connect Google Search Console.</p>
        </div>
      )}

      {conn && !snapshots?.length && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6 mb-6 flex items-center justify-between">
          <div>
            <p className="text-blue-400 font-medium">No index data yet</p>
            <p className="text-gray-400 text-sm mt-1">
              Run a sync to pull today's data, or wait for the 8am automatic sync.
            </p>
          </div>
          <a
            href="/settings"
            className="flex-shrink-0 ml-4 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition"
          >
            Go to Sync →
          </a>
        </div>
      )}

      {conn && !!snapshots?.length && (
        <>
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
              {latest && (
                <p className="text-xs text-gray-500 mt-1">as of {latest.snapshot_date}</p>
              )}
            </div>
          </div>

          {/* 14-day trend */}
          <h2 className="text-white font-semibold mb-3">
            14-Day Trend
            <span className="text-gray-500 font-normal text-sm ml-2">({snapshots.length} days of data)</span>
          </h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Indexed Pages</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Errors</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Daily Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {snapshots.map((snap, i) => {
                  const prev = snapshots[i + 1]
                  const diff = prev ? snap.indexed_pages - prev.indexed_pages : null
                  return (
                    <tr key={snap.id} className={`hover:bg-gray-800/50 transition ${i === 0 ? 'bg-blue-900/10' : ''}`}>
                      <td className="px-5 py-3 text-gray-300">
                        {snap.snapshot_date}
                        {i === 0 && <span className="text-xs text-blue-400 ml-2">latest</span>}
                      </td>
                      <td className="px-5 py-3 text-right text-white">{snap.indexed_pages?.toLocaleString()}</td>
                      <td className={`px-5 py-3 text-right ${snap.errors > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                        {snap.errors}
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${
                        diff === null ? 'text-gray-500' : diff < -50 ? 'text-red-400' : diff > 0 ? 'text-green-400' : 'text-gray-400'
                      }`}>
                        {diff === null ? '—' : diff > 0 ? `+${diff}` : diff}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Alert log */}
      {!!alerts?.length && (
        <>
          <h2 className="text-white font-semibold mb-3">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3">
                <p className="text-red-400 font-medium text-sm">{a.title}</p>
                <p className="text-gray-400 text-xs mt-0.5">{new Date(a.created_at).toLocaleString('id-ID')}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
