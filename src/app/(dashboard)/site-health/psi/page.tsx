'use client'

/**
 * /site-health/psi — PageSpeed Insights snapshot dashboard.
 *
 * Asst Manager's monthly check (Workflow #3 step 3.9). Each row = one
 * page's latest mobile PSI run. Sorted by performance ASC so worst
 * performers surface first.
 */

import { useEffect, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

interface Snapshot {
  page_url:        string
  snapshot_date:   string
  performance:     number | null
  accessibility:   number | null
  best_practices:  number | null
  seo:             number | null
  lcp_ms:          number | null
  inp_ms:          number | null
  cls:             number | null
  ttfb_ms:         number | null
  fcp_ms:          number | null
  cwv_passed:      boolean | null
  top_issues:      Array<{ title: string; savings_ms?: number }>
  http_status:     number | null
  error:           string | null
}

interface Stats { total: number; cwv_pass: number; cwv_fail: number; median_perf: number | null }

function scoreColor(s: number | null): string {
  if (s == null) return 'text-gray-600'
  if (s >= 90) return 'text-green-400'
  if (s >= 50) return 'text-amber-400'
  return 'text-red-400'
}

function fmtMs(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n)}ms`
}

export default function PsiHealthPage() {
  const siteSlug = useSiteSlug()
  const [data, setData] = useState<{ stats: Stats; snapshots: Snapshot[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/site-health/psi?site=${siteSlug}`)
      .then(r => r.json())
      .then(d => setData({ stats: d.stats, snapshots: d.snapshots ?? [] }))
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false))
  }, [siteSlug])

  return (
    <div className="p-8 max-w-6xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">⚡ PageSpeed Insights</h1>
        <p className="text-gray-400 text-sm mt-1">
          Mobile Lighthouse scores + Core Web Vitals (LCP, INP, CLS) per top page. Updated monthly via Google PSI API.
        </p>
      </header>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Pages tested',  value: data.stats.total,       color: 'text-white'    },
            { label: 'CWV pass',      value: data.stats.cwv_pass,    color: 'text-green-400' },
            { label: 'CWV fail',      value: data.stats.cwv_fail,    color: 'text-red-400'   },
            { label: 'Median perf',   value: data.stats.median_perf ?? '—', color: scoreColor(data.stats.median_perf) },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-center text-gray-500 py-12">Loading…</p>
      ) : !data || data.snapshots.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">⚡</p>
          <p className="text-gray-400 text-sm">No PSI snapshots yet.</p>
          <p className="text-gray-600 text-xs mt-1">First run is on the 1st of next month, or trigger manually via GitHub Actions → Monthly PageSpeed Insights → Run workflow. Requires PSI_API_KEY env var.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/40 border-b border-gray-800">
              <tr>
                <th className="text-left py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Page</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">Perf</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">A11y</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">BP</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">SEO</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">LCP</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">INP</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">CLS</th>
                <th className="text-center py-2 px-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16">CWV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {data.snapshots.map(s => {
                const path = s.page_url.replace(/^https?:\/\/[^/]+/, '')
                const isExp = expanded === s.page_url
                return (
                  <>
                    <tr
                      key={s.page_url}
                      onClick={() => setExpanded(isExp ? null : s.page_url)}
                      className="hover:bg-gray-800/30 cursor-pointer"
                    >
                      <td className="py-2 px-3">
                        <span className="text-gray-200 truncate max-w-md inline-block" title={s.page_url}>{path}</span>
                      </td>
                      <td className={`py-2 px-3 text-center font-bold ${scoreColor(s.performance)}`}>{s.performance ?? '—'}</td>
                      <td className={`py-2 px-3 text-center font-bold ${scoreColor(s.accessibility)}`}>{s.accessibility ?? '—'}</td>
                      <td className={`py-2 px-3 text-center font-bold ${scoreColor(s.best_practices)}`}>{s.best_practices ?? '—'}</td>
                      <td className={`py-2 px-3 text-center font-bold ${scoreColor(s.seo)}`}>{s.seo ?? '—'}</td>
                      <td className={`py-2 px-3 text-center text-xs ${s.lcp_ms != null && s.lcp_ms <= 2500 ? 'text-green-400' : s.lcp_ms != null && s.lcp_ms <= 4000 ? 'text-amber-400' : 'text-red-400'}`}>{fmtMs(s.lcp_ms)}</td>
                      <td className={`py-2 px-3 text-center text-xs ${s.inp_ms != null && s.inp_ms <= 200 ? 'text-green-400' : s.inp_ms != null && s.inp_ms <= 500 ? 'text-amber-400' : 'text-red-400'}`}>{fmtMs(s.inp_ms)}</td>
                      <td className={`py-2 px-3 text-center text-xs ${s.cls != null && s.cls <= 0.1 ? 'text-green-400' : s.cls != null && s.cls <= 0.25 ? 'text-amber-400' : 'text-red-400'}`}>
                        {s.cls != null ? s.cls.toFixed(3) : '—'}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {s.cwv_passed === true  ? <span className="text-green-400">✓</span> :
                         s.cwv_passed === false ? <span className="text-red-400">✕</span>   :
                                                  <span className="text-gray-600">—</span>}
                      </td>
                    </tr>
                    {isExp && (s.top_issues?.length > 0 || s.error) && (
                      <tr className="bg-gray-950/50 border-b border-gray-800">
                        <td colSpan={9} className="py-3 px-6">
                          {s.error ? (
                            <p className="text-xs text-red-400">⚠️ {s.error}</p>
                          ) : (
                            <>
                              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-2">Top opportunities</p>
                              <ul className="space-y-1">
                                {s.top_issues.slice(0, 5).map((iss, i) => (
                                  <li key={i} className="text-xs text-gray-300 flex items-baseline gap-2">
                                    <span className="text-amber-300 font-mono w-16 flex-shrink-0">
                                      {iss.savings_ms ? `~${(iss.savings_ms / 1000).toFixed(1)}s` : ''}
                                    </span>
                                    <span>{iss.title}</span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
