'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Exclusion {
  id:            string
  pattern:       string
  match_type:    string
  source:        'manual' | 'auto'
  source_domain: string | null
  created_at:    string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function groupBySourceDomain(exclusions: Exclusion[]): Map<string | null, Exclusion[]> {
  const map = new Map<string | null, Exclusion[]>()
  for (const ex of exclusions) {
    const key = ex.source === 'auto' ? ex.source_domain : null
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(ex)
  }
  return map
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KeywordExclusionsPage() {
  const [exclusions,  setExclusions]  = useState<Exclusion[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')

  // Manual add form
  const [newPattern,  setNewPattern]  = useState('')
  const [addError,    setAddError]    = useState('')
  const [adding,      setAdding]      = useState(false)

  // Auto-generate from domain
  const [autoDomain,  setAutoDomain]  = useState('')
  const [autoError,   setAutoError]   = useState('')
  const [autoLoading, setAutoLoading] = useState(false)
  const [autoToast,   setAutoToast]   = useState('')

  // Competitor sync
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncToast,   setSyncToast]   = useState('')

  // Delete state
  const [deleting,    setDeleting]    = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState<Set<string>>(new Set())

  // Filter / search
  const [search,      setSearch]      = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'manual' | 'auto'>('all')

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const fetchExclusions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/keyword-exclusions')
      if (!res.ok) { const d = await res.json(); setError(d.error ?? 'Failed'); return }
      const data = await res.json()
      setExclusions(data.exclusions ?? [])
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchExclusions() }, [fetchExclusions])

  // ── Add manual pattern ─────────────────────────────────────────────────────
  async function handleAdd() {
    if (!newPattern.trim()) { setAddError('Pattern is required'); return }
    setAdding(true)
    setAddError('')
    try {
      const res = await fetch('/api/keyword-exclusions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pattern: newPattern.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setAddError(data.error ?? 'Failed'); return }
      setNewPattern('')
      await fetchExclusions()
    } catch { setAddError('Network error') }
    finally { setAdding(false) }
  }

  // ── Auto-generate from domain ──────────────────────────────────────────────
  async function handleAutoDomain() {
    if (!autoDomain.trim()) return
    setAutoLoading(true)
    setAutoError('')
    setAutoToast('')
    try {
      const res = await fetch('/api/keyword-exclusions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ auto_from_domain: autoDomain.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setAutoError(data.error ?? 'Failed'); return }
      setAutoDomain('')
      setAutoToast(`Added ${data.added ?? 0} pattern${data.added !== 1 ? 's' : ''} from ${autoDomain}`)
      setTimeout(() => setAutoToast(''), 3000)
      await fetchExclusions()
    } catch { setAutoError('Network error') }
    finally { setAutoLoading(false) }
  }

  // ── Sync from all competitors ──────────────────────────────────────────────
  async function handleSyncCompetitors() {
    setSyncLoading(true)
    setSyncToast('')
    try {
      const res = await fetch('/api/keyword-exclusions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ auto_from_competitors: true }),
      })
      const data = await res.json()
      if (!res.ok) { setSyncToast(`Error: ${data.error ?? 'Failed'}`); return }
      setSyncToast(`Synced — ${data.added ?? 0} new pattern${data.added !== 1 ? 's' : ''} added`)
      setTimeout(() => setSyncToast(''), 4000)
      await fetchExclusions()
    } catch { setSyncToast('Network error') }
    finally { setSyncLoading(false) }
  }

  // ── Delete single ──────────────────────────────────────────────────────────
  async function handleDelete(id: string) {
    setDeleting(prev => new Set(prev).add(id))
    try {
      await fetch('/api/keyword-exclusions', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id }),
      })
      setExclusions(prev => prev.filter(e => e.id !== id))
    } finally {
      setDeleting(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  // ── Bulk delete by source_domain ──────────────────────────────────────────
  async function handleBulkDelete(sourceDomain: string) {
    setBulkDeleting(prev => new Set(prev).add(sourceDomain))
    try {
      await fetch('/api/keyword-exclusions', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ source_domain: sourceDomain }),
      })
      setExclusions(prev => prev.filter(e => e.source_domain !== sourceDomain))
    } finally {
      setBulkDeleting(prev => { const n = new Set(prev); n.delete(sourceDomain); return n })
    }
  }

  // ── Clear all auto ─────────────────────────────────────────────────────────
  async function handleClearAuto() {
    if (!confirm('Remove all auto-generated exclusions? Manual ones will be kept.')) return
    try {
      await fetch('/api/keyword-exclusions', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clear_auto: true }),
      })
      setExclusions(prev => prev.filter(e => e.source !== 'auto'))
    } catch { /* silent */ }
  }

  // ── Filter ─────────────────────────────────────────────────────────────────
  const filtered = exclusions.filter(e => {
    if (sourceFilter !== 'all' && e.source !== sourceFilter) return false
    if (search && !e.pattern.toLowerCase().includes(search.toLowerCase()) &&
        !(e.source_domain ?? '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const manualCount = exclusions.filter(e => e.source === 'manual').length
  const autoCount   = exclusions.filter(e => e.source === 'auto').length

  // Auto exclusions grouped by source domain (for the grouped section)
  const autoGroups = groupBySourceDomain(exclusions.filter(e => e.source === 'auto'))

  return (
    <div className="min-h-screen bg-gray-950 p-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Keyword Exclusions</h1>
        <p className="text-gray-400 text-sm mt-1">
          Patterns blocked from keyword discovery — Heimdall and Loki skip any keyword containing these strings.
        </p>
      </div>

      {/* ── Stats strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total exclusions', value: exclusions.length, color: 'text-white' },
          { label: 'Manual patterns',  value: manualCount,       color: 'text-blue-400' },
          { label: 'Auto-generated',   value: autoCount,         color: 'text-purple-400' },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-gray-500 text-xs mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* ── Action cards ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">

        {/* Manual add */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-white font-semibold mb-1">+ Add Manual Pattern</h2>
          <p className="text-gray-500 text-xs mb-3">Keywords containing this string will be excluded. Case-insensitive.</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={newPattern}
              onChange={e => setNewPattern(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="e.g. playerauctions, boost, carry service"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              onClick={handleAdd}
              disabled={adding || !newPattern.trim()}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
            >
              {adding ? '…' : 'Add'}
            </button>
          </div>
          {addError && <p className="text-xs text-red-400 mt-2">{addError}</p>}
        </div>

        {/* Auto from domain */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-white font-semibold mb-1">🤖 Auto-generate from Domain</h2>
          <p className="text-gray-500 text-xs mb-3">Generates brand-name variants from a competitor domain (e.g. playerauctions.com → playerauctions, player auction…).</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={autoDomain}
              onChange={e => setAutoDomain(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAutoDomain()}
              placeholder="e.g. playerauctions.com"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
            <button
              onClick={handleAutoDomain}
              disabled={autoLoading || !autoDomain.trim()}
              className="px-4 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
            >
              {autoLoading ? '…' : 'Generate'}
            </button>
          </div>
          {autoError && <p className="text-xs text-red-400 mt-2">{autoError}</p>}
          {autoToast && <p className="text-xs text-green-400 mt-2">✓ {autoToast}</p>}
        </div>
      </div>

      {/* ── Sync from tracked competitors ──────────────────────────────────── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6 flex items-center justify-between gap-4">
        <div>
          <p className="text-white text-sm font-medium">🔄 Sync from all tracked competitors</p>
          <p className="text-gray-500 text-xs mt-0.5">Auto-generates brand exclusion patterns for every active competitor in your tracker.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {syncToast && <p className={`text-xs ${syncToast.startsWith('Error') ? 'text-red-400' : 'text-green-400'}`}>{syncToast}</p>}
          <button
            onClick={handleSyncCompetitors}
            disabled={syncLoading}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition flex items-center gap-2"
          >
            {syncLoading ? <><span className="animate-spin">⟳</span> Syncing…</> : '🔄 Sync Competitors'}
          </button>
        </div>
      </div>

      {/* ── Table header / filters ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1">
          {(['all', 'manual', 'auto'] as const).map(f => (
            <button
              key={f}
              onClick={() => setSourceFilter(f)}
              className={`px-3 py-1.5 rounded text-xs font-medium transition ${
                sourceFilter === f ? 'bg-red-700 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              {f === 'all' ? `All (${exclusions.length})` : f === 'manual' ? `Manual (${manualCount})` : `Auto (${autoCount})`}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search pattern or domain…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-52"
        />

        {autoCount > 0 && (
          <button
            onClick={handleClearAuto}
            className="ml-auto text-xs text-red-500 hover:text-red-400 transition"
          >
            Clear all auto-generated
          </button>
        )}
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-3 mb-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* ── Loading ─────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="text-center py-16 text-gray-500">Loading exclusions…</div>
      )}

      {/* ── Empty ──────────────────────────────────────────────────────────── */}
      {!loading && exclusions.length === 0 && (
        <div className="text-center py-16 text-gray-600">
          <p className="text-4xl mb-3">🚫</p>
          <p className="text-sm">No keyword exclusions yet.</p>
          <p className="text-xs mt-1">Add patterns manually, or sync from your tracked competitors to get started.</p>
        </div>
      )}

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      {!loading && filtered.length > 0 && (
        <>
          {/* If showing auto and not filtered by search, group by source domain */}
          {sourceFilter !== 'manual' && !search && autoGroups.size > 0 && (
            <div className="space-y-4 mb-6">
              {[...autoGroups.entries()].map(([domain, items]) => {
                if (!domain) return null // manual items handled in flat table below
                return (
                  <div key={domain} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-800/50">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400 bg-purple-900/30 px-2 py-0.5 rounded">auto</span>
                        <span className="text-white text-sm font-medium">{domain}</span>
                        <span className="text-gray-500 text-xs">({items.length} pattern{items.length !== 1 ? 's' : ''})</span>
                      </div>
                      <button
                        onClick={() => handleBulkDelete(domain)}
                        disabled={bulkDeleting.has(domain)}
                        className="text-xs text-red-500 hover:text-red-400 transition disabled:opacity-50"
                      >
                        {bulkDeleting.has(domain) ? 'Removing…' : 'Remove all'}
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2 p-4">
                      {items.map(ex => (
                        <span
                          key={ex.id}
                          className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-full px-3 py-1"
                        >
                          {ex.pattern}
                          <button
                            onClick={() => handleDelete(ex.id)}
                            disabled={deleting.has(ex.id)}
                            className="text-gray-600 hover:text-red-400 transition ml-0.5 disabled:opacity-50"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Manual patterns (or flat list when searching) */}
          {(() => {
            const manualItems = search
              ? filtered // when searching, show everything flat
              : filtered.filter(e => e.source === 'manual')

            if (!search && sourceFilter === 'auto') return null // pure auto view — already shown above
            if (manualItems.length === 0) return null

            return (
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                {!search && (
                  <div className="px-4 py-3 border-b border-gray-800 bg-gray-800/50">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">Manual patterns</span>
                    <span className="text-gray-500 text-xs ml-2">({manualItems.length})</span>
                  </div>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800">
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Pattern</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Match type</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Source</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-gray-500">Added</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualItems.map(ex => (
                      <tr key={ex.id} className="border-b border-gray-800/40 hover:bg-gray-800/20">
                        <td className="px-4 py-2.5">
                          <code className="text-gray-200 text-sm font-mono bg-gray-800 px-2 py-0.5 rounded">{ex.pattern}</code>
                        </td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{ex.match_type}</td>
                        <td className="px-4 py-2.5">
                          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                            ex.source === 'manual'
                              ? 'text-blue-400 bg-blue-900/30'
                              : 'text-purple-400 bg-purple-900/30'
                          }`}>
                            {ex.source}
                          </span>
                          {ex.source_domain && (
                            <span className="text-gray-600 text-xs ml-1.5">{ex.source_domain}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600 text-xs">
                          {new Date(ex.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            onClick={() => handleDelete(ex.id)}
                            disabled={deleting.has(ex.id)}
                            className="text-xs text-red-500 hover:text-red-400 hover:bg-red-900/20 px-2 py-1 rounded transition disabled:opacity-50"
                          >
                            {deleting.has(ex.id) ? '…' : '✕'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })()}
        </>
      )}

      {/* ── No results ──────────────────────────────────────────────────────── */}
      {!loading && exclusions.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12 text-gray-600">
          <p className="text-sm">No patterns match your search.</p>
        </div>
      )}
    </div>
  )
}
