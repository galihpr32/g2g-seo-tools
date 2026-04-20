'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

type Status = 'new' | 'reviewing' | 'approved' | 'rejected'

interface PageOpportunity {
  id: string
  cluster_name: string
  game_category: string | null
  keywords: string[]
  avg_volume: number | null
  total_volume: number | null
  competitor_domain: string | null
  status: Status
  notes: string | null
  created_at: string
}

const STATUS_META: Record<Status, { label: string; color: string; bg: string }> = {
  new:       { label: 'New',       color: 'text-blue-400',   bg: 'bg-blue-500/15 border-blue-500/30' },
  reviewing: { label: 'Reviewing', color: 'text-yellow-400', bg: 'bg-yellow-500/15 border-yellow-500/30' },
  approved:  { label: 'Approved',  color: 'text-green-400',  bg: 'bg-green-500/15 border-green-500/30' },
  rejected:  { label: 'Rejected',  color: 'text-gray-500',   bg: 'bg-gray-800 border-gray-700' },
}
const STATUS_ORDER: Status[] = ['new', 'reviewing', 'approved', 'rejected']

// ── Opportunity card ──────────────────────────────────────────────────────────
function OpportunityCard({ opp, onUpdate, onDelete }: {
  opp: PageOpportunity
  onUpdate: (id: string, updates: Partial<PageOpportunity>) => void
  onDelete: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing,  setEditing]  = useState(false)
  const [notes,    setNotes]    = useState(opp.notes ?? '')
  const [saving,   setSaving]   = useState(false)
  const [deleting, setDeleting] = useState(false)
  const meta = STATUS_META[opp.status]

  async function changeStatus(status: Status) {
    const res = await fetch(`/api/competitive/opportunities?id=${opp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) onUpdate(opp.id, { status })
  }

  async function saveNotes() {
    setSaving(true)
    const res = await fetch(`/api/competitive/opportunities?id=${opp.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    })
    if (res.ok) { onUpdate(opp.id, { notes }); setEditing(false) }
    setSaving(false)
  }

  async function handleDelete() {
    if (!confirm(`Delete "${opp.cluster_name}"?`)) return
    setDeleting(true)
    await fetch(`/api/competitive/opportunities?id=${opp.id}`, { method: 'DELETE' })
    onDelete(opp.id)
  }

  return (
    <div className={`border rounded-xl overflow-hidden transition ${opp.status === 'rejected' ? 'opacity-50' : ''} ${meta.bg}`}>
      {/* Header row */}
      <div className="flex items-start gap-4 p-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <h3 className="text-white font-semibold text-sm">{opp.cluster_name}</h3>
            {opp.game_category && (
              <span className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">{opp.game_category}</span>
            )}
            <span className={`text-xs border px-2 py-0.5 rounded-full ${meta.bg} ${meta.color}`}>{meta.label}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span>{opp.keywords.length} keywords</span>
            {opp.total_volume && opp.total_volume > 0 && (
              <span>~{(opp.total_volume / 1000).toFixed(0)}K vol/mo</span>
            )}
            {opp.competitor_domain && <span>via {opp.competitor_domain}</span>}
            <span>{new Date(opp.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </div>
        </div>

        {/* Status changer */}
        <select
          value={opp.status}
          onChange={e => changeStatus(e.target.value as Status)}
          onClick={e => e.stopPropagation()}
          className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-red-500 flex-shrink-0"
        >
          {STATUS_ORDER.map(s => (
            <option key={s} value={s}>{STATUS_META[s].label}</option>
          ))}
        </select>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button onClick={() => setExpanded(e => !e)}
            className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-gray-800/60 hover:bg-gray-700 transition">
            {expanded ? '▲ Less' : '▼ More'}
          </button>
          <button onClick={handleDelete} disabled={deleting}
            className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 rounded bg-gray-800/60 hover:bg-red-500/10 transition">
            {deleting ? '…' : '✕'}
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-700/40 px-4 py-4 space-y-3">
          {/* Keywords */}
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">Keywords</p>
            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
              {opp.keywords.map(kw => (
                <span key={kw} className="text-xs bg-gray-900 text-gray-300 px-2 py-0.5 rounded-full">{kw}</span>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Notes</p>
              {!editing && (
                <button onClick={() => setEditing(true)}
                  className="text-xs text-gray-500 hover:text-white transition">Edit</button>
              )}
            </div>
            {editing ? (
              <div className="space-y-2">
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-red-500" />
                <div className="flex gap-2">
                  <button onClick={saveNotes} disabled={saving}
                    className="text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => { setEditing(false); setNotes(opp.notes ?? '') }}
                    className="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg transition">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400">{opp.notes || <span className="text-gray-600 italic">No notes</span>}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function OpportunitiesPage() {
  const [opps, setOpps]       = useState<PageOpportunity[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilter] = useState<Status | 'all'>('all')
  const [search, setSearch]   = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/competitive/opportunities')
      if (res.ok) {
        const { opportunities } = await res.json()
        setOpps(opportunities)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  function handleUpdate(id: string, updates: Partial<PageOpportunity>) {
    setOpps(prev => prev.map(o => o.id === id ? { ...o, ...updates } : o))
  }
  function handleDelete(id: string) {
    setOpps(prev => prev.filter(o => o.id !== id))
  }

  const filtered = useMemo(() => {
    let list = opps
    if (filterStatus !== 'all') list = list.filter(o => o.status === filterStatus)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(o =>
        o.cluster_name.toLowerCase().includes(q) ||
        (o.game_category?.toLowerCase().includes(q)) ||
        o.keywords.some(k => k.includes(q))
      )
    }
    return list
  }, [opps, filterStatus, search])

  // Counts per status
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: opps.length }
    STATUS_ORDER.forEach(s => { c[s] = opps.filter(o => o.status === s).length })
    return c
  }, [opps])

  // CSV export
  function exportCsv() {
    const header = ['Cluster Name', 'Game Category', 'Keywords', 'Total Volume', 'Avg Volume', 'Competitor', 'Status', 'Notes', 'Created']
    const rows = filtered.map(o => [
      o.cluster_name,
      o.game_category ?? '',
      o.keywords.join(' | '),
      o.total_volume ?? '',
      o.avg_volume ?? '',
      o.competitor_domain ?? '',
      o.status,
      (o.notes ?? '').replace(/\n/g, ' '),
      new Date(o.created_at).toLocaleDateString('en-US'),
    ])
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const a    = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `page-opportunities-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">🆕 Page Opportunities</h1>
          <p className="text-gray-400 text-sm mt-1">
            New product/category page ideas discovered via keyword gap analysis.
            Share with the product team to inform what G2G should build next.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {filtered.length > 0 && (
            <button onClick={exportCsv}
              className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-2 rounded-lg transition flex items-center gap-1.5">
              ↓ Export CSV
            </button>
          )}
          <a href="/competitive/keyword-gap"
            className="text-xs text-red-400 hover:text-red-300 border border-red-700/40 hover:border-red-600 px-3 py-2 rounded-lg transition">
            + Find more →
          </a>
        </div>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
        {(['all', ...STATUS_ORDER] as const).map(s => (
          <button key={s} onClick={() => setFilter(s)}
            className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px capitalize ${
              filterStatus === s
                ? `${s === 'all' ? 'text-white' : STATUS_META[s as Status].color} border-current`
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}>
            {s === 'all' ? 'All' : STATUS_META[s as Status].label}
            <span className="ml-1.5 text-xs opacity-60">{counts[s] ?? 0}</span>
          </button>
        ))}

        {/* Search */}
        <div className="ml-auto pb-2">
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-44" />
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <LottieLoader size={80} text="Loading opportunities…" />
        </div>
      )}

      {/* Empty state */}
      {!loading && opps.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🆕</p>
          <p className="text-white font-semibold mb-1">No page opportunities yet</p>
          <p className="text-gray-400 text-sm mb-5">
            Run a Keyword Gap analysis, select keywords where G2G doesn't rank, and flag them as new page opportunities.
          </p>
          <a href="/competitive/keyword-gap"
            className="inline-block bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition">
            Go to Keyword Gap →
          </a>
        </div>
      )}

      {!loading && filtered.length === 0 && opps.length > 0 && (
        <p className="text-gray-500 text-sm text-center py-8">No opportunities match your filters.</p>
      )}

      {/* Cards */}
      {!loading && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map(o => (
            <OpportunityCard key={o.id} opp={o} onUpdate={handleUpdate} onDelete={handleDelete} />
          ))}
        </div>
      )}

      {/* Info banner */}
      {!loading && opps.filter(o => o.status === 'approved').length > 0 && (
        <div className="mt-6 bg-green-500/5 border border-green-500/20 rounded-xl p-4">
          <p className="text-green-300 text-xs font-medium mb-1">
            ✅ {opps.filter(o => o.status === 'approved').length} approved opportunit{opps.filter(o => o.status === 'approved').length === 1 ? 'y' : 'ies'}
          </p>
          <p className="text-gray-500 text-xs">
            Export the CSV above to share approved opportunities with your product team.
          </p>
        </div>
      )}
    </div>
  )
}
