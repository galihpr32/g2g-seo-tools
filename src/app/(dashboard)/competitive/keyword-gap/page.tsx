'use client'

import { useState, useEffect, useMemo } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'
import { IntentBadge, type Intent } from '@/components/ui/IntentBadge'

interface Competitor        { id: string; domain: string; name: string; active: boolean }
interface TrackedProduct    { id: string; name: string; page_url: string; keywords: string[] }

interface GapRow {
  keyword: string
  searchVolume: number
  cpc: number
  g2g_position: number | null
  competitor_position: number | null
  position_diff: number | null
  g2g_url: string | null
  competitor_url: string | null
}

interface GapResult {
  competitor_domain: string
  g2g_domain: string
  database: string
  summary: { g2g_total: number; competitor_total: number; gaps: number; behind: number; winning: number }
  gaps: GapRow[]
  behind: GapRow[]
  winning: GapRow[]
}

type Tab     = 'gaps' | 'behind' | 'winning'
type SortKey = 'keyword' | 'searchVolume' | 'g2g_position' | 'competitor_position' | 'position_diff'

// ── Helpers ───────────────────────────────────────────────────────────────────
function positionBadge(pos: number | null) {
  if (pos === null) return <span className="text-gray-600 text-xs">—</span>
  const color = pos <= 3 ? 'text-green-400' : pos <= 10 ? 'text-yellow-400' : pos <= 20 ? 'text-orange-400' : 'text-gray-400'
  return <span className={`text-xs font-semibold ${color}`}>#{pos}</span>
}

/** Suggest a cluster name from a list of keywords (most frequent meaningful words) */
function suggestClusterName(keywords: string[]): string {
  if (keywords.length === 0) return ''
  const stop = new Set(['the','a','an','and','or','for','of','in','on','to','buy','sell','cheap','free','best','top','how','get'])
  const freq = new Map<string, number>()
  for (const kw of keywords) {
    for (const w of kw.split(' ')) {
      const lw = w.toLowerCase()
      if (lw.length > 2 && !stop.has(lw)) freq.set(lw, (freq.get(lw) ?? 0) + 1)
    }
  }
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w)
  return top.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

// ── Optimize Page Modal ───────────────────────────────────────────────────────
function OptimizeModal({ selected, trackedProducts, competitorDomain, onClose, onSuccess }: {
  selected: GapRow[]
  trackedProducts: TrackedProduct[]
  competitorDomain: string
  onClose: () => void
  onSuccess: (msg: string) => void
}) {
  const [urlMode, setUrlMode]   = useState<'product' | 'custom'>(trackedProducts.length > 0 ? 'product' : 'custom')
  const [productId, setProduct] = useState(trackedProducts[0]?.id ?? '')
  const [customUrl, setCustom]  = useState('')
  const [notes, setNotes]       = useState(() => {
    const kws = selected.map(r => r.keyword).join(', ')
    return `Keyword gap opportunity vs ${competitorDomain}.\n\nTarget keywords to improve: ${kws}`
  })
  const [saving, setSaving]     = useState(false)
  const [err, setErr]           = useState<string | null>(null)

  const targetUrl = urlMode === 'product'
    ? trackedProducts.find(p => p.id === productId)?.page_url ?? ''
    : customUrl.trim()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!targetUrl) { setErr('Please select or enter a target URL.'); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: targetUrl, action_type: 'on_page', notes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSuccess(`✅ Action item created for ${selected.length} keyword${selected.length !== 1 ? 's' : ''}`)
      onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">📝 Optimize Existing Page</h2>
        <p className="text-gray-400 text-sm mb-5">
          Create an action item to optimize a G2G page for{' '}
          <span className="text-white font-medium">{selected.length} selected keyword{selected.length !== 1 ? 's' : ''}</span>.
        </p>

        {/* Selected keywords preview */}
        <div className="flex flex-wrap gap-1.5 mb-4 max-h-20 overflow-y-auto">
          {selected.slice(0, 20).map(r => (
            <span key={r.keyword} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">
              {r.keyword}
              {r.searchVolume > 0 && <span className="ml-1 text-gray-500">{(r.searchVolume/1000).toFixed(0)}K</span>}
            </span>
          ))}
          {selected.length > 20 && <span className="text-xs text-gray-500">+{selected.length - 20} more</span>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* URL selection */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">Target G2G page</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700 mb-3">
              {trackedProducts.length > 0 && (
                <button type="button" onClick={() => setUrlMode('product')}
                  className={`text-xs px-3 py-2 flex-1 transition ${urlMode === 'product' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                  From tracked products
                </button>
              )}
              <button type="button" onClick={() => setUrlMode('custom')}
                className={`text-xs px-3 py-2 flex-1 transition ${urlMode === 'custom' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                Custom URL
              </button>
            </div>
            {urlMode === 'product' ? (
              <select value={productId} onChange={e => setProduct(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
                {trackedProducts.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            ) : (
              <input value={customUrl} onChange={e => setCustom(e.target.value)}
                placeholder="https://www.g2g.com/categories/..."
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            )}
            {targetUrl && (
              <p className="text-xs text-blue-400 mt-1 truncate">{targetUrl}</p>
            )}
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Action notes <span className="text-gray-600">(pre-filled with keyword context)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={4}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-red-500" />
          </div>

          {err && <p className="text-red-400 text-xs">{err}</p>}

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving || !targetUrl}
              className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition">
              {saving ? 'Creating…' : 'Create action item →'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── New Page Opportunity Modal ────────────────────────────────────────────────
function NewPageModal({ selected, competitorDomain, onClose, onSuccess }: {
  selected: GapRow[]
  competitorDomain: string
  onClose: () => void
  onSuccess: (msg: string) => void
}) {
  const [clusterName, setCluster]  = useState(() => suggestClusterName(selected.map(r => r.keyword)))
  const [gameCategory, setGame]    = useState('')
  const [notes, setNotes]          = useState('')
  const [saving, setSaving]        = useState(false)
  const [err, setErr]              = useState<string | null>(null)

  const totalVolume = selected.reduce((s, r) => s + (r.searchVolume ?? 0), 0)
  const avgVolume   = selected.length > 0 ? Math.round(totalVolume / selected.length) : 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!clusterName.trim()) { setErr('Cluster name is required.'); return }
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/competitive/opportunities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster_name:      clusterName.trim(),
          game_category:     gameCategory.trim() || null,
          keywords:          selected.map(r => r.keyword),
          avg_volume:        avgVolume,
          total_volume:      totalVolume,
          competitor_domain: competitorDomain,
          notes:             notes.trim() || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSuccess(`✅ "${clusterName}" saved as a new page opportunity`)
      onClose()
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg shadow-2xl">
        <h2 className="text-white font-bold text-lg mb-1">🆕 New Page Opportunity</h2>
        <p className="text-gray-400 text-sm mb-5">
          G2G doesn't rank for these keywords — flag as a potential new product/category page.
        </p>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{selected.length}</p>
            <p className="text-gray-500 text-xs">Keywords</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{totalVolume > 0 ? `${(totalVolume/1000).toFixed(0)}K` : '—'}</p>
            <p className="text-gray-500 text-xs">Total vol/mo</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-white font-bold text-lg">{avgVolume > 0 ? `${(avgVolume/1000).toFixed(0)}K` : '—'}</p>
            <p className="text-gray-500 text-xs">Avg vol/mo</p>
          </div>
        </div>

        {/* Keyword preview */}
        <div className="flex flex-wrap gap-1.5 mb-4 max-h-20 overflow-y-auto">
          {selected.slice(0, 20).map(r => (
            <span key={r.keyword} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">{r.keyword}</span>
          ))}
          {selected.length > 20 && <span className="text-xs text-gray-500">+{selected.length - 20} more</span>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Cluster name <span className="text-red-500">*</span></label>
              <input value={clusterName} onChange={e => setCluster(e.target.value)}
                placeholder="e.g. Monopoly Go Dice Links"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5">Game / category</label>
              <input value={gameCategory} onChange={e => setGame(e.target.value)}
                placeholder="e.g. Monopoly Go"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Notes for product team <span className="text-gray-600">(optional)</span></label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
              placeholder={`e.g. ${competitorDomain} ranks for these keywords, suggests strong demand. G2G currently has no product page for this category.`}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-red-500" />
          </div>

          {err && <p className="text-red-400 text-xs">{err}</p>}

          <div className="flex gap-3 pt-1">
            <button type="submit" disabled={saving || !clusterName.trim()}
              className="flex-1 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold py-2.5 rounded-lg transition">
              {saving ? 'Saving…' : 'Save opportunity →'}
            </button>
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 rounded-lg border border-gray-700 text-gray-400 text-sm hover:border-gray-500 transition">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Gap Table ─────────────────────────────────────────────────────────────────
function GapTable({ rows, tab, competitorDomain, selected, onToggle, onToggleAll, intents, intentsLoading }: {
  rows: GapRow[]
  tab: Tab
  competitorDomain: string
  selected: Set<string>
  onToggle: (kw: string) => void
  onToggleAll: (kwList: string[], checked: boolean) => void
  intents: Record<string, Intent>
  intentsLoading: boolean
}) {
  const [search, setSearch]         = useState('')
  const [sortKey, setSortKey]       = useState<SortKey>('searchVolume')
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc')
  const [minVol,  setMinVol]        = useState('')
  const [missingOnly, setMissing]   = useState(false)
  const [page, setPage]             = useState(1)
  const PAGE_SIZE = 50

  const filtered = useMemo(() => {
    let list = rows
    if (search.trim()) list = list.filter(r => r.keyword.includes(search.trim().toLowerCase()))
    if (minVol && parseInt(minVol) > 0) list = list.filter(r => r.searchVolume >= parseInt(minVol))
    if (missingOnly) list = list.filter(r => r.g2g_url === null)
    return [...list].sort((a, b) => {
      let va: number | string, vb: number | string
      switch (sortKey) {
        case 'keyword':             va = a.keyword;                          vb = b.keyword;                          break
        case 'searchVolume':        va = a.searchVolume;                     vb = b.searchVolume;                     break
        case 'g2g_position':        va = a.g2g_position ?? 999;              vb = b.g2g_position ?? 999;              break
        case 'competitor_position': va = a.competitor_position ?? 999;       vb = b.competitor_position ?? 999;       break
        case 'position_diff':       va = a.position_diff ?? 999;             vb = b.position_diff ?? 999;             break
        default:                    va = 0; vb = 0
      }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
  }, [rows, search, minVol, missingOnly, sortKey, sortDir])

  const totalPages   = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated    = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const pageKws      = paginated.map(r => r.keyword)
  const allPageSel   = pageKws.length > 0 && pageKws.every(kw => selected.has(kw))
  const missingCount = rows.filter(r => r.g2g_url === null).length

  function th(key: SortKey, label: string, align: 'left' | 'right' = 'right') {
    const active = sortKey === key
    return (
      <th
        onClick={() => { if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir(key === 'keyword' ? 'asc' : 'desc') }; setPage(1) }}
        className={`py-3 px-4 text-xs font-medium cursor-pointer select-none hover:text-white transition ${align === 'left' ? 'text-left' : 'text-right'} ${active ? 'text-white' : 'text-gray-500'}`}
      >
        {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : <span className="text-gray-700">↕</span>}
      </th>
    )
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search keyword…"
          className="flex-1 min-w-[180px] max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Min volume:</label>
          <input value={minVol} onChange={e => { setMinVol(e.target.value); setPage(1) }}
            placeholder="500"
            className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
        </div>
        {/* Missing pages only toggle (especially useful on gaps tab) */}
        {tab === 'gaps' && missingCount > 0 && (
          <button
            onClick={() => { setMissing(m => !m); setPage(1) }}
            className={`text-xs px-3 py-2 rounded-lg border transition flex items-center gap-1.5 ${
              missingOnly
                ? 'bg-orange-500/20 border-orange-500/40 text-orange-300'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
            }`}
          >
            🆕 Missing pages only
            <span className="font-semibold">{missingCount}</span>
          </button>
        )}
        <span className="text-xs text-gray-500 ml-auto">{filtered.length} keywords</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No keywords match your filters.</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr>
                {/* Select all checkbox */}
                <th className="py-3 px-4 w-10">
                  <input type="checkbox" checked={allPageSel}
                    onChange={() => onToggleAll(pageKws, !allPageSel)}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer" />
                </th>
                {th('keyword', 'Keyword', 'left')}
                {th('searchVolume', 'Volume')}
                <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">CPC</th>
                {th('g2g_position', 'G2G pos')}
                {th('competitor_position', `${competitorDomain}`)}
                {tab !== 'winning' && th('position_diff', 'Gap')}
                <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">G2G URL</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((r, i) => {
                const isSel     = selected.has(r.keyword)
                const isMissing = r.g2g_url === null
                return (
                  <tr key={i}
                    onClick={() => onToggle(r.keyword)}
                    className={`border-t border-gray-800 cursor-pointer transition ${
                      isSel ? 'bg-red-500/10' : 'hover:bg-gray-800/40'
                    }`}
                  >
                    <td className="py-2.5 px-4" onClick={e => { e.stopPropagation(); onToggle(r.keyword) }}>
                      <input type="checkbox" checked={isSel} onChange={() => {}}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-800 accent-red-500 cursor-pointer" />
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2">
                        <IntentBadge intent={intents[r.keyword]} loading={intentsLoading && !intents[r.keyword]} />
                        <span className="text-white text-xs font-medium">{r.keyword}</span>
                        {isMissing && tab === 'gaps' && (
                          <span className="text-[10px] bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded-full">no page</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-right text-gray-300 text-xs">
                      {r.searchVolume > 0 ? r.searchVolume.toLocaleString() : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right text-gray-500 text-xs">
                      {r.cpc > 0 ? `$${r.cpc.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-right">{positionBadge(r.g2g_position)}</td>
                    <td className="py-2.5 px-4 text-right">{positionBadge(r.competitor_position)}</td>
                    {tab !== 'winning' && (
                      <td className="py-2.5 px-4 text-right">
                        {r.position_diff !== null
                          ? <span className="text-red-400 text-xs font-semibold">+{r.position_diff}</span>
                          : <span className="text-orange-400 text-xs">not ranking</span>}
                      </td>
                    )}
                    <td className="py-2.5 px-4 text-right">
                      {r.g2g_url ? (
                        <a href={r.g2g_url} target="_blank" rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="text-blue-400 hover:text-blue-300 text-xs truncate max-w-[160px] inline-block" title={r.g2g_url}>
                          {(() => { try { return new URL(r.g2g_url).pathname } catch { return r.g2g_url } })()}
                        </a>
                      ) : <span className="text-gray-700 text-xs">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-500">Page {page} of {totalPages} · {filtered.length} results</span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">‹ Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">Next ›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function KeywordGapPage() {
  const [competitors, setCompetitors]         = useState<Competitor[]>([])
  const [trackedProducts, setTrackedProducts] = useState<TrackedProduct[]>([])
  const [selectedCompetitor, setCompetitor]   = useState('')
  const [database, setDatabase]               = useState('us')
  const [limit, setLimit]                     = useState('500')
  const [loading, setLoading]                 = useState(false)
  const [loadingMeta, setLoadingMeta]         = useState(true)
  const [result, setResult]                   = useState<GapResult | null>(null)
  const [error, setError]                     = useState<string | null>(null)
  const [activeTab, setActiveTab]             = useState<Tab>('gaps')
  const [successMsg, setSuccessMsg]           = useState<string | null>(null)
  const [intents, setIntents]                 = useState<Record<string, Intent>>({})
  const [intentsLoading, setIntentsLoading]   = useState(false)

  // Selection state (keyword string as key)
  const [selected, setSelected]               = useState<Set<string>>(new Set())

  // Modal state
  const [showOptimize, setShowOptimize]       = useState(false)
  const [showNewPage, setShowNewPage]         = useState(false)

  useEffect(() => {
    async function fetchMeta() {
      try {
        const [compRes, prodRes] = await Promise.all([
          fetch('/api/competitors'),
          fetch('/api/products'),
        ])
        if (compRes.ok) {
          const { competitors } = await compRes.json()
          const active = competitors.filter((c: Competitor) => c.active)
          setCompetitors(active)
          if (active.length > 0) setCompetitor(active[0].domain)
        }
        if (prodRes.ok) {
          const { products } = await prodRes.json()
          setTrackedProducts(products.filter((p: TrackedProduct & { active: boolean }) => p.active))
        }
      } catch { /* silent */ }
      finally { setLoadingMeta(false) }
    }
    fetchMeta()
  }, [])

  async function runAnalysis() {
    if (!selectedCompetitor) return
    setLoading(true); setError(null); setResult(null); setSelected(new Set())
    try {
      const res = await fetch('/api/competitive/keyword-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitor_domain: selectedCompetitor, database, limit: parseInt(limit) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
      setActiveTab('gaps')
      // Non-blocking intent fetch
      const allKeywords = [
        ...data.gaps.map((r: GapRow) => r.keyword),
        ...data.behind.map((r: GapRow) => r.keyword),
        ...data.winning.map((r: GapRow) => r.keyword),
      ]
      if (allKeywords.length > 0) {
        setIntentsLoading(true)
        fetch('/api/keywords/intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keywords: allKeywords }),
        })
          .then(r => r.json())
          .then(d => { if (d.intents) setIntents(d.intents) })
          .catch(() => {})
          .finally(() => setIntentsLoading(false))
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function toggleKw(kw: string) {
    setSelected(prev => { const n = new Set(prev); n.has(kw) ? n.delete(kw) : n.add(kw); return n })
  }
  function toggleAll(kwList: string[], checked: boolean) {
    setSelected(prev => {
      const n = new Set(prev)
      kwList.forEach(kw => checked ? n.add(kw) : n.delete(kw))
      return n
    })
  }

  // Selected row objects (for modals)
  const selectedRows = useMemo(() => {
    if (!result) return []
    const allRows = [...result.gaps, ...result.behind, ...result.winning]
    const seen = new Set<string>()
    const unique: GapRow[] = []
    for (const r of allRows) { if (!seen.has(r.keyword)) { seen.add(r.keyword); unique.push(r) } }
    return unique.filter(r => selected.has(r.keyword))
  }, [result, selected])

  const hasMissingSelected = selectedRows.some(r => r.g2g_url === null)
  const hasExistingSelected = selectedRows.some(r => r.g2g_url !== null)

  const TAB_LABELS: { key: Tab; label: string; color: string; desc: string }[] = [
    { key: 'gaps',    label: 'Keyword Gaps',   color: 'text-red-400',    desc: 'Competitor ranks top 30, G2G not ranking' },
    { key: 'behind',  label: 'Falling Behind', color: 'text-orange-400', desc: 'Both rank, but G2G is 10+ positions behind' },
    { key: 'winning', label: 'Winning',         color: 'text-green-400',  desc: 'G2G ranks better or competitor not ranking' },
  ]

  const activeRows = result
    ? activeTab === 'gaps' ? result.gaps : activeTab === 'behind' ? result.behind : result.winning
    : []

  return (
    <div className="p-8">
      {/* Modals */}
      {showOptimize && result && (
        <OptimizeModal
          selected={selectedRows}
          trackedProducts={trackedProducts}
          competitorDomain={result.competitor_domain}
          onClose={() => setShowOptimize(false)}
          onSuccess={msg => { setSuccessMsg(msg); setSelected(new Set()) }}
        />
      )}
      {showNewPage && result && (
        <NewPageModal
          selected={selectedRows.filter(r => r.g2g_url === null)}
          competitorDomain={result.competitor_domain}
          onClose={() => setShowNewPage(false)}
          onSuccess={msg => { setSuccessMsg(msg); setSelected(new Set()) }}
        />
      )}

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔍 Keyword Gap Finder</h1>
        <p className="text-gray-400 text-sm mt-1">
          Compare G2G's organic keyword rankings against a competitor to find opportunities.
        </p>
      </div>

      {/* Success banner */}
      {successMsg && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 mb-5 flex items-center justify-between">
          <p className="text-green-400 text-sm font-medium">{successMsg}</p>
          <div className="flex items-center gap-3">
            {successMsg.includes('action item') && (
              <a href="/gsc/action-items" className="text-xs text-green-300 underline hover:text-green-200">View Action Items →</a>
            )}
            {successMsg.includes('opportunity') && (
              <a href="/competitive/opportunities" className="text-xs text-green-300 underline hover:text-green-200">View Opportunities →</a>
            )}
            <button onClick={() => setSuccessMsg(null)} className="text-gray-500 hover:text-white text-xs">✕</button>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-400 mb-1.5">Competitor domain</label>
            {loadingMeta ? (
              <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
            ) : competitors.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-gray-500 text-sm">No competitors yet.</p>
                <a href="/competitive/competitors" className="text-xs text-red-400 hover:text-red-300 underline">+ Add competitors →</a>
              </div>
            ) : (
              <select value={selectedCompetitor} onChange={e => setCompetitor(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
                {competitors.map(c => (
                  <option key={c.id} value={c.domain}>{c.name} ({c.domain})</option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Market</label>
            <select value={database} onChange={e => setDatabase(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              {SERP_COUNTRIES.map(c => (
                <option key={c.code} value={c.semrushDb}>{c.flag} {c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Keywords to fetch</label>
            <select value={limit} onChange={e => setLimit(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="200">Top 200</option>
              <option value="500">Top 500</option>
              <option value="1000">Top 1,000</option>
            </select>
          </div>
          <button onClick={runAnalysis} disabled={loading || !selectedCompetitor}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            {loading ? '⏳ Analyzing…' : '🔍 Run analysis'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Uses SEMrush <code className="text-gray-500">domain_organic</code> API — fetches top organic keywords for G2G and the competitor, then computes the gap. ~2 SEMrush API units per run.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">⚠️ {error}</div>
      )}

      {loading && (
        <div className="flex justify-center py-16"><LottieLoader size={90} text="Fetching keywords from SEMrush…" /></div>
      )}

      {result && !loading && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-5 gap-3 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{result.summary.g2g_total.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">G2G keywords</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{result.summary.competitor_total.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">{result.competitor_domain}</p>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-red-400">{result.summary.gaps}</p>
              <p className="text-xs text-gray-500 mt-1">Keyword gaps</p>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-400">{result.summary.behind}</p>
              <p className="text-xs text-gray-500 mt-1">Falling behind</p>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-400">{result.summary.winning}</p>
              <p className="text-xs text-gray-500 mt-1">G2G winning</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
            {TAB_LABELS.map(t => (
              <button key={t.key} onClick={() => { setActiveTab(t.key); setSelected(new Set()) }}
                className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
                  activeTab === t.key ? `${t.color} border-current` : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}>
                {t.label}
                <span className="ml-2 text-xs opacity-70">
                  {t.key === 'gaps' ? result.gaps.length : t.key === 'behind' ? result.behind.length : result.winning.length}
                </span>
              </button>
            ))}
            <span className="ml-auto text-xs text-gray-600 pb-2">{TAB_LABELS.find(t => t.key === activeTab)?.desc}</span>
          </div>

          <GapTable
            rows={activeRows}
            tab={activeTab}
            competitorDomain={result.competitor_domain}
            selected={selected}
            onToggle={toggleKw}
            onToggleAll={toggleAll}
            intents={intents}
            intentsLoading={intentsLoading}
          />
        </>
      )}

      {/* ── Floating action bar ──────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 border border-gray-600 rounded-2xl px-5 py-3 shadow-2xl shadow-black/40">
          <span className="text-white text-sm font-medium">
            {selected.size} keyword{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-5 bg-gray-700" />

          {/* Optimize existing page — show if any selected row has a G2G URL OR we can pick one manually */}
          <button onClick={() => setShowOptimize(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition flex items-center gap-1.5">
            📝 Optimize page
          </button>

          {/* New page opportunity — show when missing-page keywords are selected */}
          {hasMissingSelected && (
            <button onClick={() => setShowNewPage(true)}
              className="bg-orange-700 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition flex items-center gap-1.5">
              🆕 New page opportunity
              <span className="text-orange-300 text-xs">({selectedRows.filter(r => r.g2g_url === null).length})</span>
            </button>
          )}

          <button onClick={() => setSelected(new Set())} className="text-gray-400 hover:text-white text-sm transition">✕</button>
        </div>
      )}
    </div>
  )
}
