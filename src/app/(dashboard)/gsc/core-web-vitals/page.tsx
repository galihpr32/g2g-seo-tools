import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getActiveSiteSlug } from '@/lib/sites'

export const revalidate = 3600

function CWVBar({ good, ni, poor, label }: { good: number; ni: number; poor: number; label: string }) {
  const total = good + ni + poor || 1
  const gPct = Math.round((good / total) * 100)
  const nPct = Math.round((ni / total) * 100)
  const pPct = Math.round((poor / total) * 100)
  const status = pPct > 25 ? 'Poor' : nPct > 40 ? 'Needs Work' : 'Good'
  const statusColor = pPct > 25 ? 'text-red-400' : nPct > 40 ? 'text-yellow-400' : 'text-green-400'
  const borderColor = pPct > 25 ? 'border-red-500/20 bg-red-500/5' : nPct > 40 ? 'border-yellow-500/20 bg-yellow-500/5' : 'border-green-500/20 bg-green-500/5'

  return (
    <div className={`border rounded-xl p-5 ${borderColor}`}>
      <div className="flex items-center justify-between mb-4">
        <p className="text-white font-semibold text-sm">{label}</p>
        <span className={`text-sm font-bold ${statusColor}`}>{status}</span>
      </div>
      <div className="flex rounded-full overflow-hidden h-3 mb-3">
        <div className="bg-green-500 transition-all" style={{ width: `${gPct}%` }} title={`Good: ${gPct}%`} />
        <div className="bg-yellow-500 transition-all" style={{ width: `${nPct}%` }} title={`Needs Improvement: ${nPct}%`} />
        <div className="bg-red-500 transition-all" style={{ width: `${pPct}%` }} title={`Poor: ${pPct}%`} />
      </div>
      <div className="flex justify-between text-xs">
        <span className="text-green-400">✓ Good {gPct}%</span>
        <span className="text-yellow-400">~ NI {nPct}%</span>
        <span className="text-red-400">✗ Poor {pPct}%</span>
      </div>
    </div>
  )
}

export default async function CoreWebVitalsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  // Use service client so workspace members can read owner's snapshots (bypasses RLS)
  const db = createServiceClient()

  // Multi-brand-safe site resolution (Sprint 12).
  const activeSlug = await getActiveSiteSlug()
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', activeSlug)
    .eq('is_active', true)
    .maybeSingle()
  // We still verify the user has a GSC connection — if not, no data to show.
  const { data: conn } = effectiveOwnerId
    ? await db.from('gsc_connections').select('user_id').eq('user_id', effectiveOwnerId).maybeSingle()
    : { data: null }
  const siteUrl = (conn && siteConfig?.gsc_property) ? siteConfig.gsc_property : null

  const { data: snapshots } = siteUrl
    ? await db
        .from('gsc_cwv_snapshots')
        .select('*')
        .eq('site_url', siteUrl)
        .order('snapshot_date', { ascending: false })
        .limit(10)
    : { data: [] }

  const { data: alerts } = await db
    .from('alert_log')
    .select('*')
    .eq('alert_type', 'cwv')
    .order('created_at', { ascending: false })
    .limit(5)

  const latest = snapshots?.[0]

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">⚡ Core Web Vitals</h1>
          <p className="text-gray-400 text-sm mt-1">Daily CWV monitoring via Chrome UX Report (CrUX API)</p>
        </div>
        <div className="flex items-center gap-2">
          {latest && (
            <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">
              {latest.snapshot_date}
            </span>
          )}
          {latest?.origin && (
            <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1.5 rounded-full">
              {latest.origin}
            </span>
          )}
        </div>
      </div>

      {!conn && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-6">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections to connect Google Search Console.</p>
        </div>
      )}

      {conn && !snapshots?.length && (
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-6 flex items-center justify-between">
          <div>
            <p className="text-blue-400 font-medium">No CWV data yet</p>
            <p className="text-gray-400 text-sm mt-1">
              CWV data is pulled from the CrUX API daily. Run a sync or wait for the 8am cron.
            </p>
            <p className="text-gray-500 text-xs mt-1">
              Requires <code className="text-gray-400 bg-gray-800 px-1 rounded">CRUX_API_KEY</code> in Vercel env vars.
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
          {/* CWV Bars */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <CWVBar
              label="LCP — Largest Contentful Paint"
              good={latest.lcp_good}
              ni={latest.lcp_ni}
              poor={latest.lcp_poor}
            />
            <CWVBar
              label="CLS — Cumulative Layout Shift"
              good={latest.cls_good}
              ni={latest.cls_ni}
              poor={latest.cls_poor}
            />
            <CWVBar
              label="INP — Interaction to Next Paint"
              good={latest.inp_good}
              ni={latest.inp_ni}
              poor={latest.inp_poor}
            />
          </div>

          {/* Benchmark note */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3 mb-6 text-xs text-gray-400 flex items-center gap-2">
            <span>📌</span>
            <span>Google threshold: <span className="text-green-400">Good</span> = top 75%, <span className="text-red-400">Poor</span> = bottom 25% of real user experience.</span>
          </div>

          {/* 10-day trend */}
          <h2 className="text-white font-semibold mb-3">
            Historical Trend — % Poor
            <span className="text-gray-500 font-normal text-sm ml-2">({snapshots.length} days)</span>
          </h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">LCP Poor</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">CLS Poor</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">INP Poor</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Overall</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {snapshots.map((snap, i) => {
                  const avgPoor = (snap.lcp_poor + snap.cls_poor + snap.inp_poor) / 3
                  return (
                    <tr key={snap.id} className={`hover:bg-gray-800/50 transition ${i === 0 ? 'bg-blue-900/10' : ''}`}>
                      <td className="px-5 py-3 text-gray-300">
                        {snap.snapshot_date}
                        {i === 0 && <span className="text-xs text-blue-400 ml-2">latest</span>}
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${snap.lcp_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                        {Math.round(snap.lcp_poor * 100)}%
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${snap.cls_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                        {Math.round(snap.cls_poor * 100)}%
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${snap.inp_poor > 0.25 ? 'text-red-400' : 'text-gray-300'}`}>
                        {Math.round(snap.inp_poor * 100)}%
                      </td>
                      <td className={`px-5 py-3 text-right font-medium ${avgPoor > 0.25 ? 'text-red-400' : avgPoor > 0.1 ? 'text-yellow-400' : 'text-green-400'}`}>
                        {Math.round(avgPoor * 100)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!!alerts?.length && (
        <div className="mt-8">
          <h2 className="text-white font-semibold mb-3">Recent CWV Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-4 py-3">
                <p className="text-orange-400 font-medium text-sm">{a.title}</p>
                <p className="text-gray-400 text-xs mt-0.5">{new Date(a.created_at).toLocaleString('id-ID')}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
