'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import { TIER_CATEGORY_PRESETS } from '@/lib/product-tiers'   // kept as fallback when KB fetch fails
import CatalogPicker from '@/components/g2g/CatalogPicker'
import BulkFromCatalogModal from '@/components/g2g/BulkFromCatalogModal'
import PasteNamesModal from '@/components/g2g/PasteNamesModal'

/**
 * /settings/product-tiers
 *
 * Manage Tier 1 (top 10 per brand) and Tier 2 (next 25) products. The list is
 * static — Galih uploads once, swaps manually. Per-site (G2G vs OffGamers),
 * driven by the active brand picker. Same page, different list per brand.
 */

interface TierRow {
  id:               string
  site_slug:        string
  market:           'us' | 'id'      // Sprint TIER.PER.MARKET
  tier:             1 | 2
  product_name:     string
  category:         string | null
  relation_id:      string | null
  url:              string | null
  notes:            string | null
  restriction_type: string | null   // Sprint DMCA.TAGGING — DMCA | Trademark | RegionLock | TOS | null
  created_at:       string
  updated_at:       string
}

// Sprint TIER.PER.MARKET — market labels for the UI picker
const MARKET_OPTIONS: Array<{ value: 'us' | 'id'; label: string; emoji: string; cls: string }> = [
  { value: 'us', label: 'Global / US', emoji: '🌐', cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  { value: 'id', label: 'Indonesia',    emoji: '🇮🇩', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
]

// Sprint DMCA.TAGGING — UI metadata for restriction picker
const RESTRICTION_OPTIONS: Array<{ value: 'DMCA' | 'Trademark' | 'RegionLock' | 'TOS'; label: string; hint: string }> = [
  { value: 'DMCA',       label: '🚫 DMCA',          hint: 'HoYoverse-style takedown risk; rank suppression expected' },
  { value: 'Trademark',  label: '™️ Trademark',     hint: 'Protected brand keywords; restricted commerce' },
  { value: 'RegionLock', label: '🌐 Region Lock',    hint: 'License limits visibility outside specific regions (e.g. China-only)' },
  { value: 'TOS',        label: '⚠️ TOS Restricted', hint: 'Platform terms prohibit sale (e.g. Mobile Legends)' },
]

interface CategoryTierCount { t1: number; t2: number; total: number }
interface MarketTierCount { t1: number; t2: number; total: number }
interface ApiList {
  items: TierRow[]
  stats: {
    tier1: number
    tier2: number
    total: number
    byCategory:     Record<string, number>
    byCategoryTier: Record<string, CategoryTierCount>
    byMarket?:      Record<string, MarketTierCount>
  }
}

const UNCATEGORIZED = 'Uncategorized'
const T1_CAP_PER_CATEGORY = 10
const T2_CAP_PER_CATEGORY = 25

// (Per-category caps live as T1_CAP_PER_CATEGORY / T2_CAP_PER_CATEGORY above.)

export default function ProductTiersPage() {
  const siteSlug = useSiteSlug()

  const [items,  setItems]  = useState<TierRow[]>([])
  const [stats,  setStats]  = useState<ApiList['stats']>({ tier1: 0, tier2: 0, total: 0, byCategory: {}, byCategoryTier: {}, byMarket: { us: { t1: 0, t2: 0, total: 0 }, id: { t1: 0, t2: 0, total: 0 } } })
  const [loading, setLoading] = useState(true)
  const [filterTier,     setFilterTier]     = useState<'all' | '1' | '2'>('all')
  const [filterCategory, setFilterCategory] = useState<string>('all')
  // Sprint TIER.PER.MARKET — filter rows by target market
  const [filterMarket,   setFilterMarket]   = useState<'all' | 'us' | 'id'>('all')
  const [search, setSearch] = useState('')

  // Sprint UNIFY.4 — Dynamic categories from KB. Single source of truth for
  // names so tier admin, datalist, filter, and brief generator stay aligned.
  // Falls back to TIER_CATEGORY_PRESETS hardcoded list if KB fetch fails.
  const [kbCategories, setKbCategories] = useState<string[]>([...TIER_CATEGORY_PRESETS])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/knowledge-base/categories')
        if (!res.ok) return
        const data = await res.json() as { categories?: Array<{ name: string }> }
        if (cancelled) return
        const names = (data.categories ?? []).map(c => c.name).filter(Boolean)
        if (names.length) setKbCategories(names)
      } catch { /* silent — keep fallback */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Editor state — null = not editing, {} = creating new, populated = editing
  const [editing, setEditing] = useState<Partial<TierRow> | null>(null)
  const [saving,  setSaving]  = useState(false)

  // CSV import state
  const [csvOpen,  setCsvOpen]    = useState(false)
  const [csvText,  setCsvText]    = useState('')
  const [csvReplace, setCsvReplace] = useState(false)
  const [csvBusy,  setCsvBusy]    = useState(false)
  const [csvResult, setCsvResult] = useState<{ inserted: number; updated: number; errors: { row: number; reason: string }[] } | null>(null)

  // Bulk-from-catalog modal state
  const [bulkCatalogOpen, setBulkCatalogOpen] = useState(false)
  const [pasteNamesOpen,  setPasteNamesOpen]  = useState(false)

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
      setStats(data.stats ?? { tier1: 0, tier2: 0, total: 0, byCategory: {}, byCategoryTier: {} })
    } finally {
      setLoading(false)
    }
  }

  // ── Filtered list ───────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    return items.filter(r => {
      if (filterTier !== 'all' && String(r.tier) !== filterTier) return false
      if (filterMarket !== 'all' && (r.market ?? 'us') !== filterMarket) return false
      if (filterCategory !== 'all') {
        const c = r.category?.trim() || UNCATEGORIZED
        if (c !== filterCategory) return false
      }
      if (!s) return true
      return [r.product_name, r.category, r.relation_id, r.url, r.notes]
        .filter(Boolean)
        .some(v => (v as string).toLowerCase().includes(s))
    })
  }, [items, filterTier, filterMarket, filterCategory, search])

  // Unique categories present (sorted; presets surfaced first when used).
  const categoryOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of items) set.add(r.category?.trim() || UNCATEGORIZED)
    return Array.from(set).sort()
  }, [items])

  // Group visible rows by category for table sectioning. Tier badges still
  // appear per-row so the user sees the mix within each category.
  const groupedByCategory = useMemo(() => {
    const groups: Record<string, TierRow[]> = {}
    for (const r of visible) {
      const k = r.category?.trim() || UNCATEGORIZED
      groups[k] ??= []
      groups[k].push(r)
    }
    // Sort: known presets first in their declared order, custom categories
    // alphabetically, Uncategorized at the bottom.
    const presetOrder = new Map<string, number>(kbCategories.map((p, i) => [p, i]))
    const keys = Object.keys(groups).sort((a, b) => {
      if (a === UNCATEGORIZED) return 1
      if (b === UNCATEGORIZED) return -1
      const ia = presetOrder.get(a) ?? Infinity
      const ib = presetOrder.get(b) ?? Infinity
      if (ia !== ib) return ia - ib
      return a.localeCompare(b)
    })
    return keys.map(k => ({ category: k, rows: groups[k] }))
  }, [visible, kbCategories])

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
          tier:             editing.tier,
          product_name:     editing.product_name?.trim(),
          category:         editing.category ?? null,
          relation_id:      editing.relation_id ?? null,
          url:              editing.url ?? null,
          notes:            editing.notes ?? null,
          restriction_type: editing.restriction_type ?? null,
          market:           editing.market ?? 'us',
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
            Top-priority products per category for the <strong className="text-white">{siteSlug.toUpperCase()}</strong> brand.
            Each category has its own <strong className="text-amber-300">Tier 1 (top 10)</strong> + <strong className="text-blue-300">Tier 2 (next 25)</strong>.
            Standards developed here propagate to the rest of the catalog via KB rules.
          </p>
        </div>
        <button
          onClick={() => setEditing({ tier: 1, market: 'us', product_name: '', category: null, relation_id: null, url: null, notes: null })}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition"
        >
          + Add Product
        </button>
      </div>

      {/* Per-category × per-tier coverage matrix. Each category gets its own
           T1 (top 10) + T2 (next 25) slots. Empty categories show as gray. */}
      <CategoryCoverage byCategoryTier={stats.byCategoryTier} totalRows={stats.total} />


      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search by name / category / relation ID / URL / notes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[260px] bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
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
        {/* Sprint TIER.PER.MARKET — market filter */}
        <select
          value={filterMarket}
          onChange={e => setFilterMarket(e.target.value as 'all' | 'us' | 'id')}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
          title="Filter rows by target market"
        >
          <option value="all">All markets</option>
          <option value="us">🌐 Global / US ({stats.byMarket?.us.total ?? 0})</option>
          <option value="id">🇮🇩 Indonesia ({stats.byMarket?.id.total ?? 0})</option>
        </select>
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
        >
          <option value="all">All categories</option>
          {categoryOptions.map(c => (
            <option key={c} value={c}>{c} ({stats.byCategory[c] ?? 0})</option>
          ))}
        </select>
        <button
          onClick={() => setCsvOpen(true)}
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700"
        >
          📥 Bulk CSV
        </button>
        <button
          onClick={() => setBulkCatalogOpen(true)}
          className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm rounded-lg transition"
        >
          📚 Bulk from Catalog
        </button>
        <button
          onClick={() => setPasteNamesOpen(true)}
          title="Paste a list of product names → auto-match relation_id + URL from canonical catalog"
          className="px-3 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded-lg transition"
        >
          📝 Paste Names
        </button>
      </div>

      {/* Grouped table — one section per category. Tier badges still shown
           per-row so the mix is visible inside each category. */}
      {loading ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <p className="text-sm text-gray-500">
            {items.length === 0 ? 'No products tiered yet — add one above or bulk-import via CSV.' : 'No products match this filter.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groupedByCategory.map(({ category, rows }) => (
            <div key={category} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-800/40 border-b border-gray-800 flex items-baseline justify-between">
                <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">{category}</h3>
                <span className="text-[11px] text-gray-500">{rows.length} product{rows.length !== 1 ? 's' : ''}</span>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-gray-800/30 text-gray-500 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left  px-3 py-2 w-14">Tier</th>
                    <th className="text-left  px-3 py-2">Product</th>
                    <th className="text-left  px-3 py-2 hidden md:table-cell">Relation ID</th>
                    <th className="text-left  px-3 py-2 hidden lg:table-cell">URL</th>
                    <th className="text-left  px-3 py-2 hidden xl:table-cell">Notes</th>
                    <th className="text-right px-3 py-2 w-28">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className="border-t border-gray-800 hover:bg-gray-800/30">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <TierBadge tier={row.tier} />
                          <MarketBadge market={row.market ?? 'us'} />
                        </div>
                      </td>
                      <td className="px-3 py-2 text-white font-medium">
                        <span className="inline-flex items-center gap-1.5 flex-wrap">
                          {row.product_name}
                          <RestrictionBadgeAdmin restriction={row.restriction_type} />
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-400 text-xs font-mono hidden md:table-cell break-all">{row.relation_id ?? '—'}</td>
                      <td className="px-3 py-2 text-gray-400 text-xs hidden lg:table-cell truncate max-w-[280px]">
                        {row.url ? <a href={row.url} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">{row.url}</a> : '—'}
                      </td>
                      <td className="px-3 py-2 text-gray-400 text-xs hidden xl:table-cell truncate max-w-[200px]">{row.notes ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => setEditing(row)} className="text-blue-400 hover:text-blue-300 text-xs px-2 mr-1">Edit</button>
                        <button onClick={() => remove(row.id)}  className="text-red-400  hover:text-red-300  text-xs px-2">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

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
              {/* Sprint TIER.PER.MARKET — market picker */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Target Market <span className="text-gray-600">— same product can be tiered in BOTH (creates 2 rows)</span>
                </label>
                <div className="flex gap-2">
                  {MARKET_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setEditing({ ...editing, market: opt.value })}
                      className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition border ${
                        (editing.market ?? 'us') === opt.value
                          ? opt.cls
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {opt.emoji} {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-gray-500 mt-1">
                  Drives which SERP market this product is tracked in.
                  Tier 1 list per market is independent — best sellers can differ between US and ID.
                </p>
              </div>
              {/* G2G catalog typeahead — fills product_name + category + relation_id in one click */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  🔍 Pick from G2G Catalog <span className="text-gray-600">(auto-fills name + category + Relation ID)</span>
                </label>
                <CatalogPicker
                  placeholder="Type brand or category, e.g. 'Genshin' or 'Top Up'"
                  onPick={row => setEditing(prev => prev ? {
                    ...prev,
                    product_name: row.brand_name,
                    category:     row.service_name,
                    relation_id:  row.relation_id,
                    url:          prev.url ?? null,
                  } : prev)}
                />
              </div>
              <Field label="Product Name *" value={editing.product_name ?? ''}
                     onChange={v => setEditing({ ...editing, product_name: v })}
                     placeholder="e.g. Albion Online Global Account" />
              <div>
                <label className="block text-xs text-gray-400 mb-1">Category</label>
                <input
                  list="tier-category-presets"
                  type="text"
                  value={editing.category ?? ''}
                  onChange={e => setEditing({ ...editing, category: e.target.value })}
                  placeholder="Pick from list or type custom (e.g. Game Coins, Accounts)"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
                />
                <datalist id="tier-category-presets">
                  {kbCategories.map(c => <option key={c} value={c} />)}
                </datalist>
                <p className="text-[10px] text-gray-500 mt-1">Used to group products in the table + on Priority Products.</p>
              </div>
              <Field label="Relation ID" value={editing.relation_id ?? ''}
                     onChange={v => setEditing({ ...editing, relation_id: v })}
                     placeholder="(optional) — preferred match key, same as Product Content" mono />
              <Field label="URL" value={editing.url ?? ''}
                     onChange={v => setEditing({ ...editing, url: v })}
                     placeholder="(optional) — full product page URL" />
              <Field label="Notes" value={editing.notes ?? ''}
                     onChange={v => setEditing({ ...editing, notes: v })}
                     placeholder="(optional) — context, e.g. 'Q4 push target'" />

              {/* Sprint DMCA.TAGGING — restriction type picker */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Restriction <span className="text-gray-600">(optional — explains low organic visibility)</span>
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditing({ ...editing, restriction_type: null })}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition border ${
                      !editing.restriction_type
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                    }`}
                    title="No legal or platform restriction known"
                  >
                    ✅ None
                  </button>
                  {RESTRICTION_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setEditing({ ...editing, restriction_type: opt.value })}
                      title={opt.hint}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition border ${
                        editing.restriction_type === opt.value
                          ? 'bg-red-500/15 border-red-500/40 text-red-300'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:bg-gray-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {editing.restriction_type && (
                  <p className="text-[10px] text-amber-300/80 mt-1.5 italic">
                    {RESTRICTION_OPTIONS.find(o => o.value === editing.restriction_type)?.hint}
                  </p>
                )}
              </div>
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

      {/* Bulk-from-catalog modal (canonical CMS catalog) */}
      <BulkFromCatalogModal
        open={bulkCatalogOpen}
        onClose={() => setBulkCatalogOpen(false)}
        onApplied={() => { void fetchList() }}
      />

      {/* Paste-names → auto-match modal (canonical CMS catalog) */}
      <PasteNamesModal
        open={pasteNamesOpen}
        onClose={() => setPasteNamesOpen(false)}
        onApplied={() => { void fetchList() }}
      />

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
                Optional: <code className="bg-gray-800 px-1 rounded">Category</code>, <code className="bg-gray-800 px-1 rounded">Relation ID</code>, <code className="bg-gray-800 px-1 rounded">URL</code>, <code className="bg-gray-800 px-1 rounded">Notes</code>.
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
                placeholder="Tier,Product Name,Category,Relation ID,URL,Notes&#10;1,Albion Online Global Account,Game Accounts,abc-123,https://www.g2g.com/...,Q4 target&#10;1,Genshin Impact Top Up,Top Up,,https://www.g2g.com/...,High volume"
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

/**
 * Per-category coverage matrix. One card per known category showing
 *   T1: X/10  ·  T2: Y/25
 * plus a small progress bar. Helps Galih see which categories he's
 * still under-filled on, vs. which ones are over-cap.
 */
function CategoryCoverage({ byCategoryTier, totalRows }: {
  byCategoryTier: Record<string, CategoryTierCount>
  totalRows:      number
}) {
  // Sort: presets first (in declared order), then custom alphabetically,
  // Uncategorized last.
  const presetOrder = new Map<string, number>(TIER_CATEGORY_PRESETS.map((p, i) => [p, i]))
  const entries = Object.entries(byCategoryTier).sort(([a], [b]) => {
    if (a === UNCATEGORIZED) return 1
    if (b === UNCATEGORIZED) return -1
    const ia = presetOrder.get(a) ?? Infinity
    const ib = presetOrder.get(b) ?? Infinity
    if (ia !== ib) return ia - ib
    return a.localeCompare(b)
  })

  if (entries.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <p className="text-sm text-gray-400">
          No tier products yet for this brand — add one below or bulk-import via CSV.
          Each category has its own T1 (top 10) + T2 (next 25) slots.
        </p>
      </div>
    )
  }

  return (
    <div className="mb-6">
      <div className="flex items-baseline justify-between mb-2 px-1">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">Per-category coverage</h2>
        <span className="text-[11px] text-gray-500">{totalRows} total products across {entries.length} categor{entries.length !== 1 ? 'ies' : 'y'}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {entries.map(([cat, c]) => <CategoryStatCard key={cat} category={cat} counts={c} />)}
      </div>
    </div>
  )
}

function CategoryStatCard({ category, counts }: { category: string; counts: CategoryTierCount }) {
  const t1Pct = Math.min(100, (counts.t1 / T1_CAP_PER_CATEGORY) * 100)
  const t2Pct = Math.min(100, (counts.t2 / T2_CAP_PER_CATEGORY) * 100)
  const t1Over = counts.t1 > T1_CAP_PER_CATEGORY
  const t2Over = counts.t2 > T2_CAP_PER_CATEGORY
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs font-semibold text-white mb-2.5 truncate">{category}</p>
      <div className="space-y-2">
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold">Tier 1</span>
            <span className={`text-[11px] font-medium ${t1Over ? 'text-red-400' : counts.t1 === 0 ? 'text-gray-500' : 'text-amber-200'}`}>
              {counts.t1} / {T1_CAP_PER_CATEGORY}{t1Over && ' ⚠'}
            </span>
          </div>
          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full transition-all" style={{ width: `${t1Pct}%`, backgroundColor: t1Over ? '#ef4444' : '#f59e0b' }} />
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] uppercase tracking-wider text-blue-400 font-semibold">Tier 2</span>
            <span className={`text-[11px] font-medium ${t2Over ? 'text-red-400' : counts.t2 === 0 ? 'text-gray-500' : 'text-blue-200'}`}>
              {counts.t2} / {T2_CAP_PER_CATEGORY}{t2Over && ' ⚠'}
            </span>
          </div>
          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full transition-all" style={{ width: `${t2Pct}%`, backgroundColor: t2Over ? '#ef4444' : '#3b82f6' }} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Sprint DMCA.TAGGING — compact restriction badge shown next to product
 * name in the admin table. Hover for full label.
 */
function RestrictionBadgeAdmin({ restriction }: { restriction: string | null }) {
  if (!restriction) return null
  const map: Record<string, { label: string; icon: string; cls: string }> = {
    DMCA:       { label: 'DMCA',   icon: '🚫', cls: 'bg-red-500/15 text-red-300 border-red-500/30' },
    Trademark:  { label: 'TM',     icon: '™️', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
    RegionLock: { label: 'Region', icon: '🌐', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
    TOS:        { label: 'TOS',    icon: '⚠️', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  }
  const meta = map[restriction]
  if (!meta) return null
  const hint = RESTRICTION_OPTIONS.find(o => o.value === restriction)?.hint ?? restriction
  return (
    <span
      title={hint}
      className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${meta.cls}`}
    >
      <span>{meta.icon}</span><span>{meta.label}</span>
    </span>
  )
}

function TierBadge({ tier }: { tier: 1 | 2 }) {
  const cls = tier === 1
    ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-blue-500/15  text-blue-300  border-blue-500/30'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-bold ${cls}`}>T{tier}</span>
}

// Sprint TIER.PER.MARKET — compact market badge next to tier badge
function MarketBadge({ market }: { market: 'us' | 'id' }) {
  const cls = market === 'id'
    ? 'bg-red-500/15 text-red-300 border-red-500/30'
    : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
  const label = market === 'id' ? '🇮🇩 ID' : '🌐 US'
  return (
    <span
      title={market === 'id' ? 'Indonesia market' : 'Global / US market'}
      className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-bold ${cls}`}
    >
      {label}
    </span>
  )
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
