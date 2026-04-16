import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function CWVBar({ good, ni, poor, label }: { good: number; ni: number; poor: number; label: string }) {
  const total = good + ni + poor || 1
  const gPct = Math.round((good / total) * 100)
  const nPct = Math.round((ni / total) * 100)
  const pPct = Math.round((poor / total) * 100)
  const status = pPct > 25 ? 'Poor' : nPct > 40 ? 'Needs Work' : 'Good'
  const statusColor = pPct > 25 ? 'text-red-400' : nPct > 40 ? 'text-yellow-400' : 'text-green-400'

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-white font-semibold">{label}</p>
        <span className={`text-sm font-medium ${statusColor}`}>{status}</span>
      </div>
      <div className="flex rounded-full overflow-hidden h-3 mb-3">
        <div className="bg-green-500 transition-all" style={{ width: `${gPct}%` }} />
        <div className="bg-yellow-500 transition-all" style={{ width: `${nPct}%` }} />
        <div className="bg-red-500 transition-all" style={{ width: `${pPct}%` }} />
      </div>
      <div className="flex justify-between text-xs text-gray-400">
        <span className="text-green-400">Good {gPct}%</span>
        <span className="text-yellow-400">NI {nPct}%</span>
        <span className="text-red-400">Poor {pPct}%</span>
      </div>
    </div>
  )
}

export default async function CoreWebVitalsPage() {
  const supabase = await createClient()

  const { data: snapshots } = await supabase
    .from('gsc_cwv_snapshots')
    .select('*')
    .order('snapshot_date', { ascending: false })
    .limit(10)

  const latest = snapshots?.[0]

  const { data: alerts } = await supabase
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'cwv')
    .order('created_at', { ascending: false })
    .limit(5)

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">⚡ Core Web Vitals</h1>
          <p className="text-gray-400 text-sm mt-1">Daily CWV monitoring via Chrome UX Report (CrUX)</p>
        </div>
        {latest && <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">Data: {latest.snapshot_date}</span>}
      </div>

      {!latest ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-semibold">No CWV data yet</p>
          <p className="text-gray-400 text-sm mt-1">Data will appear after the first daily cron run</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-4 mb-8">
            <CWVBar
              label="LCP (Largest Contentful Paint)"
              good={latest.lcp_good}
              ni={latest.lcp_ni}
              poor={latest.lcp_poor}
            />
            <CWVBar
              label="CLS (Cumulative Layout Shift)"
              good={latest.cls_good}
              ni={latest.cls_ni}
              poor={latest.cls_poor}
            />
            <CWVBar
              label="INP (Interaction to Next Paint)"
              good={latest.inp_good}
              ni={latest.inp_ni}
              poor={latest.inp_poor}
            />
          </div>

          {/* 10-day trend table */}
          <h2 className="text-white font-semibold mb-3">10-Day Trend (% Poor)</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">LCP Poor</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">CLS Poor</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">INP Poor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {(snapshots ?? []).map((snap, i) => (
                  <tr key={snap.id} className={`hover:bg-gray-800/50 transition ${i === 0 ? 'bg-blue-900/10' : ''}`}>
                    <td className="px-5 py-3 text-gray-300">{snap.snapshot_date} {i === 0 && <span className="text-xs text-blue-400 ml-2">latest</span>}</td>
                    <td className={`px-5 py-3 text-right ${snap.lcp_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                      {Math.round(snap.lcp_poor * 100)}%
                    </td>
                    <td className={`px-5 py-3 text-right ${snap.cls_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                      {Math.round(snap.cls_poor * 100)}%
                    </td>
                    <td className={`px-5 py-3 text-right ${snap.inp_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                      {Math.round(snap.inp_poor * 100)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {alerts && alerts.length > 0 && (
        <div className="mt-8">
          <h2 className="text-white font-semibold mb-3">Recent CWV Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-4 py-3">
                <p className="text-orange-400 font-medium text-sm">{a.title}</p>
                <p className="text-gray-400 text-xs mt-0.5">{new Date(a.created_at).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
