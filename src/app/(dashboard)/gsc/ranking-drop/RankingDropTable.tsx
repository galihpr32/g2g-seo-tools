'use client'

import { useState, useMemo, useCallback } from 'react'

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

type SortKey = 'currentClicks' | 'previousClicks' | 'clicksDrop' | 'impressionsDrop' | 'currentPosition' | 'positionChange'
type SortDir = 'asc' | 'desc'
type ActionType = 'on_page' | 'off_page'

interface Props {
  drops: PageDropWithQueries[]
  totalTracked: number
  alerts: { id: string; created_at: string; title: string; severity: string }[]
  snapshotDate: string
}

function SortIcon({ col, sortKey, sortDir }: { col: SortKey; sortKey: SortKey; sortDir: SortDir }) {
  if (col !== sortKey) return <span className="text-gray-700 ml-1">↕</span>
  return <span className="text-red-400 ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
}

// ── Assign Modal ───────────────────────────────────────────────────────────────
function AssignModal({
  selectedCount,
  onConfirm,
  onCancel,
  loading,
}: {
  selectedCount: number
  onConfirm: (actionType: ActionType, notes: string) => void
  onCancel: () => void
  loading: boolean
}) {
  const [actionType, setActionType] = useState<ActionType>('on_page')
  const [notes, setNotes] = useState('')

  const ACTION_OPTIONS: { value: ActionType; label: string; desc: string; icon: string }[] = [
    {
      value: 'on_page',
      label: 'On-Page Optimization',
      desc: 'Update content, add keywords, long-tail, FAQ, internal links',
      icon: '✏️',
    },
    {
      value: 'off_page',
      label: 'Off-Page Content',
      desc: 'Create supporting blog posts, landing pages, link-building ideas',
      icon: '📣',
    },
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">Assign Next Action</h2>
        <p className="text-gray-400 text-sm mb-5">
          {selectedCount} page{selectedCount !== 1 ? 's' : ''} selected
        </p>

        {/* Action type selector */}
        <div className="space-y-3 mb-5">
          {ACTION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setActionType(opt.value)}
              className={`w-full text-left rounded-xl border p-4 transition ${
                actionType === opt.value
                  ? 'border-red-500/50 bg-red-500/10'
                  : 'border-gray-700 bg-gray-800 hover:border-gray-600'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-xl">{opt.icon}</span>
                <div>
                  <p className={`font-semibold text-sm ${actionType === opt.value ? 'text-white' : 'text-gray-300'}`}>
                    {opt.label}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                </div>
                <span className={`ml-auto w-4 h-4 rounded-full border-2 flex-shrink-0 ${
                  actionType === opt.value ? 'border-red-500 bg-red-500' : 'border-gray-600'
                }`} />
              </div>
            </button>
          ))}
        </div>

        {/* Notes */}
        <div className="mb-5">
          <label className="text-xs text-gray-500 mb-1.5 block">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Focus on long-tail buyer keywords, competitor gap analysis..."
            rows={3}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg border border-gray-700 text-gray-300 text-sm font-medium hover:border-gray-500 transition disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(actionType, notes)}
            disabled={loading}
            className="flex-1 py-2.5 rounded-lg bg-red-700 hover:bg-red-600 text-white text-sm font-semibold transition disabled:opacity-50"
          >
            {loading ? 'Saving…' : `Assign to ${selectedCount} page${selectedCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────
export function RankingDropTable({ drops, totalTracked, alerts, snapshotDate }: Props) {
  // Filters
  const [includePages, setIncludePages] = useState('/categories/')
  const [excludePages, setExcludePages] = useState('/offer/')
  const [excludeQueries, setExcludeQueries] = useState('')

  // Table state
  const [expandedPage, setExpandedPage] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('clicksDrop')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showModal, setShowModal] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null)

  const pageInclusions = useMemo(
    () => includePages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [includePages]
  )
  const pageExclusions = useMemo(
    () => excludePages.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludePages]
  )
  const queryExclusions = useMemo(
    () => excludeQueries.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    [excludeQueries]
  )

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const filtered = useMemo(() => {
    const list = drops.filter(d => {
      const pageLower = d.page.toLowerCase()
      if (pageInclusions.length > 0 && !pageInclusions.some(inc => pageLower.includes(inc))) return false
      if (pageExclusions.some(ex => pageLower.includes(ex))) return false
      return true
    })
    return [...list].sort((a, b) => {
      const va = a[sortKey]
      const vb = b[sortKey]
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [drops, pageInclusions, pageExclusions, sortKey, sortDir])

  // Selection helpers
  const allFilteredSelected = filtered.length > 0 && filtered.every(d => selected.has(d.page))
  const someSelected = selected.size > 0

  function toggleSelectAll() {
    if (allFilteredSelected) {
      const next = new Set(selected)
      filtered.forEach(d => next.delete(d.page))
      setSelected(next)
    } else {
      const next = new Set(selected)
      filtered.forEach(d => next.add(d.page))
      setSelected(next)
    }
  }

  function toggleSelect(page: string, e: React.MouseEvent) {
    e.stopPropagation()
    const next = new Set(selected)
    if (next.has(page)) next.delete(page)
    else next.add(page)
    setSelected(next)
  }

  function toggleExpand(page: string) {
    setExpandedPage(prev => (prev === page ? null : page))
  }

  function clearSelection() {
    setSelected(new Set())
    setAssignSuccess(null)
  }

  const handleAssignConfirm = useCallback(async (actionType: ActionType, notes: string) => {
    setAssigning(true)
    try {
      const selectedDrops = drops.filter(d => selected.has(d.page))
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pages: selectedDrops.map(d => ({
            page: d.page,
            clicks_drop: d.clicksDrop,
            position_change: d.positionChange,
          })),
          action_type: actionType,
          notes: notes || null,
          snapshot_date: snapshotDate,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setShowModal(false)
      setAssignSuccess(`✅ ${data.created} action item${data.created !== 1 ? 's' : ''} created`)
      setSelected(new Set())
    } catch (err) {
      alert(`Error: ${err}`)
    } finally {
      setAssigning(false)
    }
  }, [drops, selected, snapshotDate])

  function thProps(key: SortKey, label: string) {
    return (
      <th
        className="text-right text-gray-500 font-medium px-5 py-3 cursor-pointer hover:text-white select-none transition"
        onClick={() => handleSort(key)}
      >
        <span className="inline-flex items-center justify-end gap-0.5">
          {label}
          <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
        </span>
      </th>
    )
  }

  return (
    <>
      {/* Modal */}
      {showModal && (
        <AssignModal
          selectedCount={selected.size}
          onConfirm={handleAssignConfirm}
          onCancel={() => setShowModal(false)}
          loading={assigning}
        />
      )}

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

      {/* Success banner */}
      {assignSuccess && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 mb-4 flex items-center justify-between">
          <p className="text-green-400 text-sm font-medium">{assignSuccess}</p>
          <div className="flex items-center gap-3">
            <a href="/gsc/action-items" className="text-xs text-green-300 underline underline-offset-2 hover:text-green-200">
              View Action Items →
            </a>
            <button onClick={() => setAssignSuccess(null)} className="text-gray-500 hover:text-white text-xs">✕</button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-white text-sm font-medium">🔽 URL Filters</p>
          <button
            onClick={() => { setIncludePages('/categories/'); setExcludePages('/offer/'); setExcludeQueries('') }}
            className="text-xs text-gray-500 hover:text-gray-300 transition"
          >
            Reset to default
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              Include URLs <span className="text-green-500">(must contain)</span>
            </label>
            <input
              type="text"
              value={includePages}
              onChange={e => setIncludePages(e.target.value)}
              placeholder="e.g. /categories/"
              className="w-full bg-gray-800 border border-green-800/50 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-green-700 focus:border-transparent"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">
              Exclude URLs <span className="text-red-500">(must not contain)</span>
            </label>
            <input
              type="text"
              value={excludePages}
              onChange={e => setExcludePages(e.target.value)}
              placeholder="e.g. /offer/, hydron"
              className="w-full bg-gray-800 border border-red-900/50 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Exclude queries (expanded view)</label>
            <input
              type="text"
              value={excludeQueries}
              onChange={e => setExcludeQueries(e.target.value)}
              placeholder="e.g. g2g, branded"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {pageInclusions.map(inc => (
            <span key={inc} className="text-xs bg-green-700/30 text-green-300 px-2 py-0.5 rounded-full">✓ {inc}</span>
          ))}
          {pageExclusions.map(ex => (
            <span key={ex} className="text-xs bg-red-700/30 text-red-300 px-2 py-0.5 rounded-full">✗ {ex}</span>
          ))}
          {queryExclusions.map(ex => (
            <span key={ex} className="text-xs bg-orange-700/30 text-orange-300 px-2 py-0.5 rounded-full">query: {ex}</span>
          ))}
          <span className="text-xs text-gray-600 ml-auto">
            {drops.length - filtered.length > 0 ? `${drops.length - filtered.length} pages hidden by filters` : `${filtered.length} pages shown`}
          </span>
        </div>
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
              {someSelected && (
                <span className="ml-2 text-red-400">· {selected.size} selected</span>
              )}
            </p>
            <p className="text-gray-500 text-xs">Click column headers to sort · Click row to expand queries</p>
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                {/* Checkbox column */}
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    title={allFilteredSelected ? 'Deselect all' : 'Select all visible'}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer"
                  />
                </th>
                <th className="text-left text-gray-500 font-medium px-4 py-3">Page</th>
                {thProps('currentClicks', 'Clicks')}
                {thProps('previousClicks', 'Prev')}
                {thProps('clicksDrop', 'Drop %')}
                {thProps('impressionsDrop', 'Impr. drop')}
                {thProps('currentPosition', 'Position')}
                {thProps('positionChange', 'Pos Δ')}
                <th className="text-right text-gray-500 font-medium px-5 py-3">Queries</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => {
                let path = r.page
                try { path = new URL(r.page).pathname } catch { /* keep */ }
                const isExpanded = expandedPage === r.page
                const isSelected = selected.has(r.page)
                const visibleQueries = r.queries.filter(q =>
                  !queryExclusions.some(ex => q.query.toLowerCase().includes(ex))
                )

                return (
                  <>
                    <tr
                      key={r.page}
                      onClick={() => toggleExpand(r.page)}
                      className={`border-t border-gray-800 cursor-pointer transition ${
                        isSelected
                          ? 'bg-red-500/10'
                          : isExpanded
                          ? 'bg-gray-800'
                          : 'hover:bg-gray-800/50'
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="px-4 py-3" onClick={e => toggleSelect(r.page, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
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
                      <td className={`px-5 py-3 text-right font-medium ${sortKey === 'currentClicks' ? 'text-white' : 'text-gray-300'}`}>
                        {r.currentClicks.toLocaleString()}
                      </td>
                      <td className={`px-5 py-3 text-right ${sortKey === 'previousClicks' ? 'text-white' : 'text-gray-400'}`}>
                        {r.previousClicks.toLocaleString()}
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.clicksDrop >= 0.15 ? 'text-red-400' : 'text-gray-400'}`}>
                        {r.clicksDrop > 0 ? `-${Math.round(r.clicksDrop * 100)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right ${r.impressionsDrop >= 0.15 ? 'text-orange-400' : 'text-gray-400'}`}>
                        {r.impressionsDrop > 0 ? `-${Math.round(r.impressionsDrop * 100)}%` : '—'}
                      </td>
                      <td className={`px-5 py-3 text-right ${sortKey === 'currentPosition' ? 'text-white' : 'text-gray-300'}`}>
                        {r.currentPosition.toFixed(1)}
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${r.positionChange >= 5 ? 'text-orange-400' : r.positionChange < 0 ? 'text-green-400' : 'text-gray-400'}`}>
                        {r.positionChange > 0 ? `+${r.positionChange.toFixed(1)}` : r.positionChange.toFixed(1)}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-500 text-xs">
                        {r.queries.length}
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr key={`${r.page}-queries`} className="border-t border-gray-700">
                        <td colSpan={9} className="bg-gray-800/60 px-8 py-4">
                          <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-3">
                            Queries for this page (last 7 days)
                            {queryExclusions.length > 0 && visibleQueries.length < r.queries.length && (
                              <span className="ml-2 text-orange-400 normal-case">
                                · {r.queries.length - visibleQueries.length} hidden by filter
                              </span>
                            )}
                          </p>
                          {visibleQueries.length === 0 ? (
                            <p className="text-gray-500 text-sm">No query data available.</p>
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

      {/* Floating action bar */}
      {someSelected && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-4 bg-gray-900 border border-gray-600 rounded-2xl px-5 py-3 shadow-2xl shadow-black/40">
          <span className="text-white text-sm font-medium">
            {selected.size} page{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-5 bg-gray-700" />
          <button
            onClick={() => setShowModal(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition"
          >
            Assign Next Action →
          </button>
          <button
            onClick={clearSelection}
            className="text-gray-400 hover:text-white text-sm transition"
          >
            ✕ Clear
          </button>
        </div>
      )}

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
                  <span className="text-xs text-gray-500">{new Date(a.created_at).toLocaleDateString('id-ID')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
