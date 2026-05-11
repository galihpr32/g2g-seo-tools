'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'

/**
 * /settings/product-tiers
 *
 * Manage Tier 1 (top 10 per brand) and Tier 2 (next 25) products. The list is
 * static — Galih uploads once, swaps manually. Per-site (G2G vs OffGamers),
 * driven by the active brand picker. Same page, different list per brand.
 */

interface TierRow {
  id:            string
  site_slug:     string
  tier:          1 | 2
  product_name:  string
  relation_id:   string | null
  url:           string | null
  notes:         string | null
  created_at:    string
  updated_at:    string
}

interface ApiList {
  items: TierRow[]
  stats: { tier1: number; tier2: number; total: number }
}

const T1_LIMIT = 10
const T2_LIMIT = 25

export default function ProductTiersPage() {
  const siteSlug = useSiteSlug()

  const [items,  setItems]  = useState<TierRow[]>([])
  const [stats,  setStats]  = useState({ tier1: 0, tier2: 0, total: 0 })
  const [loading, setLoading] = useState(true)
  const [filterTier, setFilterTier] = useState<'all' | '1' | '2'>('all')
  const [search, setSearch] = useState('')

  // Editor state — null = not editing, {} = creating new, populated = editing
  const [editing, setEditing] = useState<Partial<TierRow> | null>(null)
  const [saving,  setSaving]  = useState(false)

  // CSV import state
  const [csvOpen,  setCsvOpen]    = useState(false)
  const [csvText,  setCsvText]    = useState('')
  const [csvReplace, setCsvReplace] = useState(false)
  const [csvBusy,  setCsvBusy]    = useState(false)
  const [csvResult, setCsvResult] = useState<{ inserted: number; updated: number; errors: { row: number; reason: string }[] } | null>(null)

  const fileRef = useRef<HTMLInputElement>(null)

  // ── Fetch ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteSlug])

  async function fetchList() {
    setLoading(true)
    try {
      const res  = await fetch('/api/product-tiers')
      const data = await res.json() as ApiList
      setItems(data.items ?? [])
      setStats(data.stats ?? { tier1: 0, tier2: 0, total: 0 })
    } finally {
      setLoading(false)
    }
  }

  // ── Filtered list ───────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    return items.filter(r => {
      if (filterTier !== 'all' && String(r.tier) !== filterTier) return false
      if (!s) return true
      return [r.product_name, r.relation_id, r.url, r.notes]
        .filter(Boolean)
        .some(v => (v as string).toLowerCase().includes(s))
    })
  }, [items, filterTier, search])

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save() {
    if (!editing) return
    if (!editing.tier || !editing.product_name?.trim()) {
      alert('Tier + Product Name required'); return
    }
    setSaving(true)
    try {
      const isNew = !editing.id
      const url   = isNew ? '/api/product-tiers' : `/api/product-tiers/${editing.id}`
      const res   = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tier:         editing.tier,
          product_name: editing.product_name?.trim(),
          relation_id:  editing.relation_id ?? null,
          url:          editing.url ?? null,
          notes:        editing.notes ?? null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(`Save failed: ${data.error ?? res.status}`); return }
      setEditing(null)
      await fetchList()
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this product from the tier list?')) return
    const res = await fetch(`/api/product-tiers/${id}`, { method: 'DELETE' })
    if (!res.ok) { alert('Delete failed'); return }
    await fetchList()
  }

  // ── CSV import ──────────────────────────────────────────────────────────────
  async function importCsv() {
    if (!csvText.trim()) { alert('Paste CSV content first'); return }
    setCsvBusy(true)
    setCsvResult(null)
    try {
      const res  = await fetch('/api/product-tiers/csv-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, replace: csvReplace }),
      })
      const data = await res.json()
      if (!res.ok) { alert(`Import failed: ${data.error ?? res.status}`); return }
      setCsvResult({ inserted: data.inserted, updated: data.updated, errors: data.errors ?? [] })
      await fetchList()
    } finally {
      setCsvBusy(false)
    }
  }

  function loadCsvFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => setCsvText(typeof reader.result === 'string' ? reader.result : '')
    reader.readAsText(file)
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">Product Tiers</h1>
          <p className="text-sm text-gray-400">
            Top-priority products for the <strong className="text-white">{siteSlug.toUpperCase()}</strong> brand.
            Tier 1 = top 10 (heavy backlink + outreach). Tier 2 = next 25.
            Standards developed here propagate to the rest of the catalog via KB rules.
          </p>
        </div>
        <button
          onClick={() => setEditing({ tier: 1, product_name: '', relation_id: null, url: null, notes: null })}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition"
        >
          + Add Product
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="Tier 1" value={stats.tier1} cap={T1_LIMIT} accent="#f59e0b" />
        <StatCard label="Tier 2" value={stats.tier2} cap={T2_LIMIT} accent="#3b82f6" />
        <StatCard label="Total"  value={stats.total} cap={T1_LIMIT + T2_LIMIT} accent="#10b981" />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4">
        <input
          type="text"
          placeholder="Search by name / relation ID / URL / notes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
        />
        <select
          value={filterTier}
          onChange={e => setFilterTier(e.target.value as 'all' | '1' | '2')}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
        >
          <option value="all">All tiers</option>
          <option value="1">Tier 1 only</option>
          <option value="2">Tier 2 only</option>
        </select>
        <button
          onClick={() => setCsvOpen(true)}
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700"
        >
          📥 Bulk CSV
        </button>
      </div>

      {/* Table */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-gray-500">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">
            {items.length === 0 ? 'No products tiered yet — add one above or bulk-import via CSV.' : 'No products match this filter.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-800/50 text-gray-400 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left  px-3 py-2.5 w-16">Tier</th>
                <th className="text-left  px-3 py-2.5">Product</th>
                <th className="text-left  px-3 py-2.5 hidden md:table-cell">Relation ID</th>
                <th className="text-left  px-3 py-2.5 hidden lg:table-cell">URL</th>
                <th className="text-left  px-3 py-2.5 hidden xl:table-cell">Notes</th>
                <th className="text-right px-3 py-2.5 w-32">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.id} className="border-t border-gray-800 hover:bg-gray-800/30">
                  <td className="px-3 py-2.5"><TierBadge tier={row.tier} /></td>
                  <td className="px-3 py-2.5 text-white font-medium">{row.product_name}</td>
                  <td className="px-3 py-2.5 text-gray-400 text-xs font-mono hidden md:table-cell break-all">{row.relation_id ?? '—'}</td>
                  <td className="px-3 py-2.5 text-gray-400 text-xs hidden lg:table-cell truncate max-w-[280px]">
                    {row.url ? <a href={row.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">{row.url}</a> : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-gray-400 text-xs hidden xl:table-cell truncate max-w-[200px]">{row.notes ?? '—'}</td>
                  <td className="px-3 py-2.5 text-right">
                    <button onClick={() => setEditing(row)} className="text-blue-400 hover:text-blue-300 text-xs px-2 mr-1">Edit</button>
                    <button onClick={() => remove(row.id)}  className="text-red-400  hover:text-red-300  text-xs px-2">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Editor modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-white font-semibold">{editing.id ? 'Edit product tier' : 'Add product tier'}</h2>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Tier</label>
                <div className="flex gap-2">
                  {[1, 2].map(t => (
                    <button
                      key={t}
                      onClick={() => setEditing({ ...editing, tier: t as 1 | 2 })}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition border ${
                        editing.tier === t
                          ? t === 1
                            ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                            : 'bg-blue-500/20 border-blue-500 text-blue-300'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      Tier {t}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Product Name *" value={editing.product_name ?? ''}
                     onChange={v => setEditing({ ...editing, product_name: v })}
                     placeholder="e.g. Albion Online Global Account" />
              <Field label="Relation ID" value={editing.relation_id ?? ''}
                     onChange={v => setEditing({ ...editing, relation_id: v })}
                     placeholder="(optional) — preferred match key, same as Product Content" mono />
              <Field label="URL" value={editing.url ?? ''}
                     onChange={v => setEditing({ ...editing, url: v })}
                     placeholder="(optional) — full product page URL" />
              <Field label="Notes" value={editing.notes ?? ''}
                     onChange={v => setEditing({ ...editing, notes: v })}
                     placeholder="(optional) — context, e.g. 'Q4 push target'" />
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg">Cancel</button>
              <button onClick={save} disabled={saving}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm rounded-lg">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV import modal */}
      {csvOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-white font-semibold">Bulk CSV import</h2>
              <button onClick={() => { setCsvOpen(false); setCsvResult(null); setCsvText('') }} className="text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-gray-400">
                Required columns (header row, case-insensitive): <code className="bg-gray-800 px-1 rounded">Tier</code>, <code className="bg-gray-800 px-1 rounded">Product Name</code>.
                Optional: <code className="bg-gray-800 px-1 rounded">Relation ID</code>, <code className="bg-gray-800 px-1 rounded">URL</code>, <code className="bg-gray-800 px-1 rounded">Notes</code>.
              </p>
              <div className="flex items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={e => { const f = e.target.files?.[0]; if (f) loadCsvFile(f) }}
                  className="hidden"
                />
                <button onClick={() => fileRef.current?.click()}
                        className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs rounded-lg border border-gray-700">
                  Pick file…
                </button>
                <span className="text-xs text-gray-500">…or paste below</span>
              </div>
              <textarea
                value={csvText}
                onChange={e => setCsvText(e.target.value)}
                placeholder="Tier,Product Name,Relation ID,URL,Notes&#10;1,Albion Online Global Account,abc-123,https://www.g2g.com/...,Q4 target"
                rows={10}
                className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-gray-600"
              />
              <label className="flex items-center gap-2 text-xs text-gray-300">
                <input type="checkbox" checked={csvReplace} onChange={e => setCsvReplace(e.target.checked)} />
                <span>Replace mode — wipe existing tier list for <strong>{siteSlug.toUpperCase()}</strong> first (else upsert by Relation ID)</span>
              </label>

              {csvResult && (
                <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-xs">
                  <p className="text-emerald-400 mb-1">Inserted: {csvResult.inserted} · Updated: {csvResult.updated}</p>
                  {csvResult.errors.length > 0 && (
                    <div className="mt-2">
                      <p className="text-red-400 mb-1">Errors:</p>
                      <ul className="text-red-300 space-y-0.5 max-h-40 overflow-y-auto">
                        {csvResult.errors.map((e, i) => <li key={i}>Row {e.row}: {e.reason}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="px-5 py-4 border-t border-gray-800 flex justify-end gap-2">
              <button onClick={() => { setCsvOpen(false); setCsvResult(null); setCsvText('') }}
                      className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg">Close</button>
              <button onClick={importCsv} disabled={csvBusy || !csvText.trim()}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm rounded-lg">
                {csvBusy ? 'Importing…' : 'Import'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({ label, value, cap, accent }: { label: string; value: number; cap: number; accent: string }) {
  const pct = Math.min(100, (value / cap) * 100)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-white leading-tight">{value} <span className="text-sm text-gray-500 font-normal">/ {cap}</span></p>
      <div className="mt-2 h-1 bg-gray-800 rounded-full overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, backgroundColor: accent }} />
      </div>
    </div>
  )
}

function TierBadge({ tier }: { tier: 1 | 2 }) {
  const cls = tier === 1
    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-blue-500/15  text-blue-300  border-blue-500/30'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-bold ${cls}`}>T{tier}</span>
}

function Field({ label, value, onChange, placeholder, mono }: {
  label:        string
  value:        string
  onChange:     (v: string) => void
  placeholder?: string
  mono?:        boolean
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600 ${mono ? 'font-mono text-xs' : ''}`}
      />
    </div>
  )
}
