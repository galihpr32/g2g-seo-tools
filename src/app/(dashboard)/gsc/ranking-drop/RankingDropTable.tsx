'use client'

import { useState, useMemo } from 'react'

export type PageDropWithQueries = {
  page: string
  currentClicks: number
  previousClicks: number
  clicksDrop: number
  currentImpressions: number
  previousImpressions: number
  impressionsDrop: number
  currentPosition: number
  previousPosition: number
  positionChange: number
  queries: {
    query: string
    clicks: number
    impressions: number
    ctr: number
    position: number
  }[]
}

interface Props {
  drops: PageDropWithQueries[]
  totalTracked: number
  alerts: { id: string; created_at: string; title: string; severity: string }[]
}

export function RankingDropTable({ drops, totalTracked, alerts }: Props) {
  const [excludePages, setExcludePages] = useState('')
  const [excludeQueries, setExcludeQueries] = useState('')
  const [expandedPage, setExpandedPage] = useState<string | null>(null)

  // Parse comma-separated exclusions
  const pageExclusions = useMemo(
    () => excludePages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludePages]
  )
  const queryExclusions = useMemo(
    () => excludeQueries.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludeQueries]
  )

  const filtered = useMemo(() => {
    return drops.filter(d => {
      const pageLower = d.page.toLowerCase()
      return !pageExclusions.some(ex => pageLower.includes(ex))
    })
  }, [drops, pageExclusions])

  function toggleExpand(page: string) {
    setExpandedPage(prev => (prev === page ? null : page))
  }

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className={`${filtered.length > 0 ? 'bg-red-500/10 border-red-500/20' : 'bg-gray-900 border-gray-800'} border rounded-xl p-4`}>
          <p className={`text-3xl font-bold ${filtered.length > 0 ? 'text-red-400' : 'text-white'}`}>{filtered.length}</p>
          <p className="text-gray-400 text-sm mt-1">Pages flagged</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-white">{totalTracked}</p>
          <p className="text-gray-400 text-sm mt-1">Total pages tracked</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-3xl font-bold text-yellow-400">{alerts.length}</p>
          <p className="text-gray-400 text-sm mt-1">Alerts sent (last 5)</p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 space-y-3">
        <p className="text-white text-sm font-medium">🔽 Filters — Exclude from view</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Exclude page URLs (comma-separated)</label>
            <input
              type="text"
              value={excludePages}
              onChange={e => setExcludePages(e.target.value)}
              placeholder="e.g. hydron, /blog/, /en/"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Exclude queries (in expanded view)</label>
            <input
              type="text"
              value={excludeQueries}
              onChange={e => setExcludeQueries(e.target.value)}
              placeholder="e.g. branded, g2g, nama brand"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
        </div>
        {(pageExclusions.length > 0 || queryExclusions.length > 0) && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {pageExclusions.map(ex => (
              <span key={ex} className="text-xs bg-red-700/30 text-red-300 px-2 py-0.5 rounded-full">
                page: {ex}
              </span>
            ))}
            {queryExclusions.map(ex => (
              <span key={ex} className="text-xs bg-orange-700/30 text-orange-300 px-2 py-0.5 rounded-full">
                query: {ex}
              </span>
            ))}
            <button
              onClick={() => { setExcludePages(''); setExcludeQueries('') }}
              className="text-xs text-gray-500 hover:text-white transition ml-auto"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-8 text-center">
          <p className="text-green-400 text-lg font-semibold">✅ No significant drops detected</p>
          <p className="text-gray-400 text-sm mt-1">
            {drops.length > 0
              ? `${drops.length} drop(s) hidden by your filters`
              : 'All tracked pages are within normal range for the past 7 days'}
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
            <p className="text-white font-medium text-sm">
              {filtered.length} page{filtered.length !== 1 ? 's' : ''} flagged
            </p>
            <p className="text-gray-500 text-xs">Click a row to see queries ↓</p>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Clicks</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Prev</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Drop %</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Impr. drop</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Position</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Pos Δ</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Queries</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                let path = r.page
                try { path = new URL(r.page).pathname } catch { /* keep */ }
                const isExpanded = expandedPage === r.page

                const visibleQueries = r.queries.filter(q =>
                  !queryExclusions.some(ex => q.query.toLowerCase().includes(ex))
                )

                return (
                  <>
                    {/* Main row */}
                    <tr
                      key={r.page}
                      onClick={() => toggleExpand(r.page)}
                      className={`border-t border-gray-800 cursor-pointer transition ${
                        isExpanded ? 'bg-gray-800' : 'hover:bg-gray-800/50'
                      }`}
                    >
                      <td className="px-5 py-3 max-w-xs">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                          <a
                            href={r.page}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="text-blue-400 hover:text-blue-300 truncate block max-w-xs"
                            title={r.page}
                          >
                            {path}
                          </a>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right text-white">{r.currentClicks.toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-400">{r.previousClicks.toLocaleString()}</td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.clicksDrop >= 0.15 ? 'text-red-400' : 'text-gray-400'}`}>
                        {r.clicksDrop > 0 ? `-${Math.round(r.clicksDrop * 100)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right ${r.impressionsDrop >= 0.15 ? 'text-orange-400' : 'text-gray-400'}`}>
                        {r.impressionsDrop > 0 ? `-${Math.round(r.impressionsDrop * 100)}%` : '—'}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-300">{r.currentPosition.toFixed(1)}</td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.positionChange >= 5 ? 'text-orange-400' : r.positionChange < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                        {r.positionChange > 0 ? `+${r.positionChange.toFixed(1)}` : r.positionChange.toFixed(1)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-500 text-xs">
                        {r.queries.length} queries
                      </td>
                    </tr>

                    {/* Expanded queries panel */}
                    {isExpanded && (
                      <tr key={`${r.page}-queries`} className="border-t border-gray-700">
                        <td colSpan={8} className="bg-gray-800/60 px-5 py-4">
                          <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-3">
                            Queries driving traffic to this page (last 7 days)
                            {queryExclusions.length > 0 && visibleQueries.length < r.queries.length && (
                              <span className="ml-2 text-orange-400 normal-case">
                                · {r.queries.length - visibleQueries.length} hidden by filter
                              </span>
                            )}
                          </p>
                          {visibleQueries.length === 0 ? (
                            <p className="text-gray-500 text-sm">No query data available for this page.</p>
                          ) : (
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-gray-700">
                                  <th className="text-left text-gray-500 font-medium py-1.5 pr-4">Query</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">Clicks</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">Impressions</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 px-3">CTR</th>
                                  <th className="text-right text-gray-500 font-medium py-1.5 pl-3">Position</th>
                                </tr>
                              </thead>
                              <tbody>
                                {visibleQueries.map((q, i) => (
                                  <tr key={i} className="border-b border-gray-700/50">
                                    <td className="py-2 pr-4 text-gray-200 font-medium">{q.query}</td>
                                    <td className="py-2 px-3 text-right text-white">{q.clicks}</td>
                                    <td className="py-2 px-3 text-right text-gray-400">{q.impressions.toLocaleString()}</td>
                                    <td className="py-2 px-3 text-right text-gray-400">{(q.ctr * 100).toFixed(1)}%</td>
                                    <td className={`py-2 pl-3 text-right font-medium ${q.position <= 10 ? 'text-green-400' : q.position <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
                                      {q.position.toFixed(1)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
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

      {/* Recent alerts log */}
      {alerts.length > 0 && (
        <div className="mt-8">
          <h2 className="text-white font-semibold mb-3">Recent Alerts</h2>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3 flex items-center justify-between">
                <p className="text-gray-300 text-sm">{a.title}</p>
                <div className="flex items-center gap-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    a.severity === 'critical' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                  }`}>{a.severity}</span>
                  <span className="text-xs text-gray-500">
                    {new Date(a.created_at).toLocaleDateString('id-ID')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
