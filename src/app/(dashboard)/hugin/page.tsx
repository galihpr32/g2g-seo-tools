'use client'

import Link from 'next/link'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// ─── /hugin — Long-tail Discovery ──────────────────────────────────────────
//
// Sprint HUGIN.PAGE — Triage UI for long-tail keywords surfaced by the daily
// aggregator. Replaces Galih's manual GSC regex workflow.
//
// Layout:
//   • Filters (period · min_words · min_impressions · search)
//   • Stats strip + tabs (Growing/New/Climbing/CTR Rising/All/Claimed/Covered/Ignored)
//   • Multi-select rows → "Cluster selected (N)" button (calls Haiku)
//   • Per-row actions: Claim → product picker · Mark covered · Mark ignored
//   • CSV export

type Tab = 'growing' | 'new' | 'climbing' | 'ctr_rising' | 'all' | 'claimed' | 'covered' | 'ignored'

interface HuginRow {
  id:                         string
  query:                      string
  query_display:              string | null
  word_count:                 number
  period_days:                number
  total_impressions:          number
  total_clicks:               number
  ctr_current:                number | null
  position_avg:               number | null
  prior_impressions:          number
  prior_clicks:               number
  ctr_prior:                  number | null
  position_prior:             number | null
  growth_pct:                 number | null
  position_delta:             number | null
  is_new:                     boolean
  top_page:                   string | null
  top_market:                 string | null
  dmca_flag:                  boolean
  phrase_pattern_match:       boolean
  auto_matched_product_id:    string | null
  auto_matched_product_name:  string | null
  status:                     string
  claimed_to_product_id:      string | null
  claimed_at:                 string | null
  last_aggregated_at:         string
}

interface Counts {
  growing:   number
  new:       number
  climbing:  number
  ctr_rising: number
  all:       number
  claimed:   number
  covered:   number
  ignored:   number
}

interface ProductOption {
  id:          string
  product_name: string
  tier:        number | null
  market:      string | null
}

interface ClusterGroup {
  cluster_id:           string
  brand:                string
  sub_product:          string
  representative_query: string
  members:              string[]
  total_impressions:    number
}

export default function HuginPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading…</div>}>
      <HuginPageInner />
    </Suspense>
  )
}

function HuginPageInner() {
  const router = useRouter()
  const sp     = useSearchParams()

  const [rows,        setRows]        = useState<HuginRow[]>([])
  const [counts,      setCounts]      = useState<Counts>({ growing: 0, new: 0, climbing: 0, ctr_rising: 0, all: 0, claimed: 0, covered: 0, ignored: 0 })
  const [loading,     setLoading]     = useState(true)
  const [refreshTick, setRefreshTick] = useState(0)

  // Filters
  const [period,   setPeriod]   = useState<number>(parseInt(sp.get('period') ?? '30', 10) || 30)
  const [tab,      setTab]      = useState<Tab>((sp.get('tab') as Tab) || 'growing')
  const [minWords, setMinWords] = useState<number>(parseInt(sp.get('min_words') ?? '4', 10) || 4)
  const [minImp,   setMinImp]   = useState<number>(parseInt(sp.get('min_impressions') ?? '30', 10) || 30)
  const [search,   setSearch]   = useState(sp.get('q') ?? '')

  // Multi-select
  const [selected,    setSelected]    = useState<Set<string>>(new Set())
  const [clusterOpen, setClusterOpen] = useState(false)
  const [clusterBusy, setClusterBusy] = useState(false)
  const [clusterRes,  setClusterRes]  = useState<{ groups: ClusterGroup[]; unclustered: string[]; error?: string } | null>(null)

  // Claim modal
  const [claimRow,    setClaimRow]    = useState<HuginRow | null>(null)

  // Sync URL
  useEffect(() => {
    const params = new URLSearchParams()
    params.set('period', String(period))
    params.set('tab',    tab)
    if (minWords !== 4) params.set('min_words',       String(minWords))
    if (minImp !== 30)  params.set('min_impressions', String(minImp))
    if (search.trim())  params.set('q', search.trim())
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [period, tab, minWords, minImp, search, router])

  // Fetch rows
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSelected(new Set())
    ;(async () => {
      try {
        const params = new URLSearchParams()
        params.set('period', String(period))
        params.set('tab',    tab)
        params.set('min_words',       String(minWords))
        params.set('min_impressions', String(minImp))
        if (search.trim()) params.set('q', search.trim())
        const res  = await fetch(`/api/hugin/queries?${params}`)
        const data = await res.json()
        if (cancelled) return
        setRows(data.rows ?? [])
        setCounts(data.counts ?? { growing: 0, new: 0, climbing: 0, ctr_rising: 0, all: 0, claimed: 0, covered: 0, ignored: 0 })
      } catch { if (!cancelled) setRows([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [period, tab, minWords, minImp, search, refreshTick])

  async function patchRow(id: string, patch: Record<string, unknown>) {
    const res = await fetch(`/api/hugin/queries?id=${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(patch),
    })
    if (res.ok) setRefreshTick(t => t + 1)
    return res
  }

  async function runCluster() {
    if (selected.size === 0) return
    setClusterBusy(true); setClusterRes(null); setClusterOpen(true)
    try {
      const res = await fetch('/api/hugin/cluster', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query_ids: Array.from(selected) }),
      })
      const data = await res.json()
      setClusterRes({ groups: data.groups ?? [], unclustered: data.unclustered ?? [], error: data.error })
    } catch (e) {
      setClusterRes({ groups: [], unclustered: [], error: e instanceof Error ? e.message : String(e) })
    }
    setClusterBusy(false)
  }

  function exportCsv() {
    const headers = ['Query', 'Words', 'Impressions', 'Prior', 'Growth %', 'New?', 'Position', 'Δ Pos', 'CTR', 'Top page', 'Status', 'Auto-match']
    const lines = [headers.join(',')]
    for (const r of rows) {
      const row = [
        `"${r.query.replace(/"/g, '""')}"`,
        r.word_count,
        r.total_impressions,
        r.prior_impressions,
        r.growth_pct == null ? '' : r.growth_pct,
        r.is_new ? 'yes' : '',
        r.position_avg == null ? '' : r.position_avg.toFixed(1),
        r.position_delta == null ? '' : r.position_delta.toFixed(1),
        r.ctr_current == null ? '' : (r.ctr_current * 100).toFixed(2),
        r.top_page ?? '',
        r.status,
        r.auto_matched_product_name ?? '',
      ]
      lines.push(row.join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = `hugin-${tab}-${period}d-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🪶 Hugin · Long-tail Discovery</h1>
          <p className="text-sm text-gray-400 mt-1">
            Long-tail GSC queries auto-aggregated daily — growth, new emergence, position climb, CTR rising.
            Pick the gold, cluster, and claim into <Link href="/priority-products" className="text-purple-400 hover:underline">Priority Products</Link>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportCsv} className="px-3 py-2 bg-emerald-700/40 hover:bg-emerald-700/60 border border-emerald-600/50 text-sm text-emerald-100 rounded-lg">📥 CSV</button>
          {selected.size > 0 && (
            <button
              onClick={runCluster}
              disabled={clusterBusy}
              className="px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg"
            >
              {clusterBusy ? '⏳ Clustering…' : `🪶 Cluster selected (${selected.size})`}
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1">
          <span className="text-gray-500">Period:</span>
          <select value={period} onChange={e => setPeriod(parseInt(e.target.value, 10))} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value={7}>7d</option>
            <option value={30}>30d</option>
            <option value={60}>60d</option>
            <option value={90}>90d</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">Min words:</span>
          <select value={minWords} onChange={e => setMinWords(parseInt(e.target.value, 10))} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            {[3, 4, 5, 6, 7].map(n => <option key={n} value={n}>≥ {n}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1">
          <span className="text-gray-500">Min impressions:</span>
          <select value={minImp} onChange={e => setMinImp(parseInt(e.target.value, 10))} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            {[10, 30, 50, 100, 250, 500].map(n => <option key={n} value={n}>≥ {n}</option>)}
          </select>
        </label>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search query text…"
          className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-purple-500 flex-1 min-w-[200px]"
        />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 text-sm border-b border-gray-800">
        <TabBtn current={tab} value="growing"    count={counts.growing}    label="📈 Growing"       onClick={setTab} />
        <TabBtn current={tab} value="new"        count={counts.new}        label="✨ New"           onClick={setTab} />
        <TabBtn current={tab} value="climbing"   count={counts.climbing}   label="↑ Position climb" onClick={setTab} />
        <TabBtn current={tab} value="ctr_rising" count={counts.ctr_rising} label="🎯 CTR rising"    onClick={setTab} />
        <TabBtn current={tab} value="all"        count={counts.all}        label="All"              onClick={setTab} />
        <TabBtn current={tab} value="claimed"    count={counts.claimed}    label="✓ Claimed"        onClick={setTab} />
        <TabBtn current={tab} value="covered"    count={counts.covered}    label="📄 Covered"       onClick={setTab} />
        <TabBtn current={tab} value="ignored"    count={counts.ignored}    label="🚫 Ignored"       onClick={setTab} />
      </div>

      {/* Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState tab={tab} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="min-w-full text-xs">
            <thead className="bg-gray-900/70 text-gray-400 uppercase tracking-wide text-[10px]">
              <tr>
                <Th className="w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={e => {
                      const next = new Set<string>()
                      if (e.target.checked) for (const r of rows) next.add(r.id)
                      setSelected(next)
                    }}
                  />
                </Th>
                <Th>Query</Th>
                <Th>W</Th>
                <Th className="text-right">Imp</Th>
                <Th className="text-right">Δ%</Th>
                <Th className="text-right">Pos</Th>
                <Th className="text-right">ΔPos</Th>
                <Th className="text-right">CTR</Th>
                <Th>Top page</Th>
                <Th>Auto-match</Th>
                <Th>Flags</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <RowItem
                  key={r.id}
                  r={r}
                  selected={selected.has(r.id)}
                  onSelect={chk => {
                    setSelected(prev => {
                      const next = new Set(prev)
                      if (chk) next.add(r.id); else next.delete(r.id)
                      return next
                    })
                  }}
                  onClaim={() => setClaimRow(r)}
                  onPatch={patch => patchRow(r.id, patch)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Claim modal */}
      {claimRow && (
        <ClaimModal
          row={claimRow}
          onClose={() => setClaimRow(null)}
          onClaimed={() => { setClaimRow(null); setRefreshTick(t => t + 1) }}
        />
      )}

      {/* Cluster results panel */}
      {clusterOpen && (
        <ClusterPanel
          busy={clusterBusy}
          result={clusterRes}
          onClose={() => { setClusterOpen(false); setClusterRes(null) }}
        />
      )}
    </div>
  )
}

// ─── Row component ─────────────────────────────────────────────────────────

function RowItem({ r, selected, onSelect, onClaim, onPatch }: {
  r:        HuginRow
  selected: boolean
  onSelect: (checked: boolean) => void
  onClaim:  () => void
  onPatch:  (patch: Record<string, unknown>) => Promise<Response>
}) {
  const growthColor = r.growth_pct == null
    ? 'text-gray-400'
    : r.growth_pct >= 100 ? 'text-emerald-300 font-semibold'
    : r.growth_pct >= 20  ? 'text-emerald-400'
    : r.growth_pct >= 0   ? 'text-gray-300'
    : 'text-red-400'

  const posDeltaColor = r.position_delta == null
    ? 'text-gray-400'
    : r.position_delta >= 3 ? 'text-emerald-300 font-semibold'
    : r.position_delta >= 1 ? 'text-emerald-400'
    : r.position_delta <= -3 ? 'text-red-400'
    : 'text-gray-300'

  return (
    <tr className="border-t border-gray-800 hover:bg-gray-900/40">
      <Td>
        <input type="checkbox" checked={selected} onChange={e => onSelect(e.target.checked)} />
      </Td>
      <Td>
        <span className="text-gray-200">{r.query_display ?? r.query}</span>
        {r.phrase_pattern_match && (
          <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded border border-blue-700/40 bg-blue-500/10 text-blue-300">phrase</span>
        )}
      </Td>
      <Td className="text-gray-400">{r.word_count}</Td>
      <Td className="text-right">
        <span className="text-gray-200">{r.total_impressions}</span>
        {r.prior_impressions > 0 && (
          <span className="text-[10px] text-gray-500 ml-1">/ {r.prior_impressions}</span>
        )}
      </Td>
      <Td className={`text-right ${growthColor}`}>
        {r.is_new ? <span className="text-purple-300 font-semibold">NEW</span> : r.growth_pct == null ? '—' : `${r.growth_pct > 0 ? '+' : ''}${r.growth_pct.toFixed(0)}%`}
      </Td>
      <Td className="text-right text-gray-300">
        {r.position_avg == null ? '—' : r.position_avg.toFixed(1)}
      </Td>
      <Td className={`text-right ${posDeltaColor}`}>
        {r.position_delta == null ? '—' : r.position_delta > 0 ? `↑${r.position_delta.toFixed(1)}` : r.position_delta < 0 ? `↓${Math.abs(r.position_delta).toFixed(1)}` : '0'}
      </Td>
      <Td className="text-right text-gray-300">
        {r.ctr_current == null ? '—' : `${(r.ctr_current * 100).toFixed(1)}%`}
      </Td>
      <td className="px-3 py-2 text-gray-400 max-w-xs truncate" title={r.top_page ?? ''}>
        {r.top_page ? <a href={r.top_page} target="_blank" rel="noopener noreferrer" className="hover:text-purple-300 truncate inline-block max-w-xs">{r.top_page.replace(/^https?:\/\/[^/]+/, '')}</a> : '—'}
      </td>
      <Td className="text-gray-300">
        {r.auto_matched_product_name ?? <span className="text-gray-600">—</span>}
      </Td>
      <Td>
        {r.dmca_flag && <span className="text-[10px] px-1 py-0.5 rounded border border-amber-700/40 bg-amber-500/10 text-amber-300">⚠ DMCA</span>}
      </Td>
      <Td className="text-right">
        <div className="flex items-center justify-end gap-1.5 text-[11px]">
          {r.status === 'discovered' ? (
            <>
              <button onClick={onClaim} className="px-1.5 py-0.5 bg-purple-700/40 hover:bg-purple-700/60 border border-purple-600/50 rounded text-purple-100">Claim</button>
              <button onClick={() => onPatch({ status: 'covered' })} className="text-gray-400 hover:text-emerald-300">Cover</button>
              <button onClick={() => onPatch({ status: 'ignored' })} className="text-gray-400 hover:text-red-300">Ignore</button>
            </>
          ) : (
            <button onClick={() => onPatch({ status: 'discovered' })} className="text-gray-400 hover:text-purple-300 text-[10px] underline">Reopen</button>
          )}
        </div>
      </Td>
    </tr>
  )
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function TabBtn({ current, value, count, label, onClick }: {
  current: Tab; value: Tab; count: number; label: string; onClick: (t: Tab) => void
}) {
  const active = current === value
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-3 py-2 -mb-px border-b-2 transition ${
        active ? 'border-purple-500 text-white font-medium' : 'border-transparent text-gray-400 hover:text-gray-200'
      }`}
    >
      {label}
      <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded ${active ? 'bg-purple-700/40 text-purple-100' : 'bg-gray-800 text-gray-400'}`}>
        {count}
      </span>
    </button>
  )
}

function EmptyState({ tab }: { tab: Tab }) {
  const msgs: Record<Tab, string> = {
    growing:    'No growing queries with current filters. Try lowering min impressions or extending the period.',
    new:        'No newly-emerged queries in this window.',
    climbing:   'No queries climbing in position.',
    ctr_rising: 'No CTR-rising queries.',
    all:        'No queries match these filters.',
    claimed:    'No claimed queries yet. Claim some from Growing/New to start tracking.',
    covered:    'Nothing marked covered.',
    ignored:    'Nothing ignored.',
  }
  return <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">{msgs[tab]}</div>
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 text-left font-medium ${className}`}>{children}</th>
}
function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>
}

// ─── Claim modal ────────────────────────────────────────────────────────────

function ClaimModal({ row, onClose, onClaimed }: { row: HuginRow; onClose: () => void; onClaimed: () => void }) {
  const [products,   setProducts]   = useState<ProductOption[]>([])
  const [productId,  setProductId]  = useState<string>(row.auto_matched_product_id ?? '')
  const [search,     setSearch]     = useState('')
  const [busy,       setBusy]       = useState(false)
  const [err,        setErr]        = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/priority-products/list?limit=1000')
        const data = await res.json()
        if (cancelled) return
        const opts = (data.products ?? data.rows ?? []).map((p: { id: string; product_name: string; tier?: number; market?: string }) => ({
          id:           p.id,
          product_name: p.product_name,
          tier:         p.tier ?? null,
          market:       p.market ?? null,
        }))
        setProducts(opts)
      } catch { /* swallow */ }
    })()
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return products.slice(0, 50)
    return products.filter(p => p.product_name.toLowerCase().includes(s)).slice(0, 50)
  }, [search, products])

  async function submit() {
    if (!productId) { setErr('Pick a product first'); return }
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/hugin/queries?id=${row.id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: 'claimed', claimed_to_product_id: productId }),
      })
      const data = await res.json()
      if (!res.ok) setErr(data.error ?? 'Failed')
      else onClaimed()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} className="bg-gray-900 border border-gray-700 rounded-lg max-w-xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white">Claim query</h2>
            <p className="text-xs text-gray-400 mt-1">&ldquo;{row.query}&rdquo;</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none ml-3">×</button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <label className="block text-xs text-gray-400">
            Assign to product:
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search products…"
              className="mt-1 w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder:text-gray-600"
            />
          </label>
          <div className="max-h-72 overflow-y-auto rounded border border-gray-800 divide-y divide-gray-800">
            {filtered.length === 0 ? (
              <p className="p-3 text-xs text-gray-500 italic">No matching products. Add one first at /priority-products.</p>
            ) : filtered.map(p => (
              <button
                key={p.id}
                onClick={() => setProductId(p.id)}
                className={`w-full text-left p-2.5 text-xs hover:bg-gray-800/60 ${productId === p.id ? 'bg-purple-700/20' : ''}`}
              >
                <p className="text-gray-200 font-medium">{p.product_name}</p>
                <p className="text-[10px] text-gray-500">
                  {p.tier ? `T${p.tier}` : ''} {p.market ? `· ${p.market}` : ''}
                </p>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-500">
            Claiming creates a tier_keywords row → the daily SERP cron starts tracking this query.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={submit} disabled={busy || !productId} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm rounded">
              {busy ? 'Claiming…' : 'Claim'}
            </button>
            <button onClick={onClose} className="px-3 py-1.5 text-gray-400 hover:text-white text-sm">Cancel</button>
            {err && <span className="text-xs text-red-400">{err}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Cluster results panel ──────────────────────────────────────────────────

function ClusterPanel({ busy, result, onClose }: {
  busy:   boolean
  result: { groups: ClusterGroup[]; unclustered: string[]; error?: string } | null
  onClose: () => void
}) {
  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div onClick={e => e.stopPropagation()} className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col">
        <div className="flex items-start justify-between p-4 border-b border-gray-800">
          <h2 className="text-base font-semibold text-white">🪶 Cluster results</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          {busy ? (
            <p className="text-sm text-gray-500 italic">Clustering with Haiku…</p>
          ) : result?.error ? (
            <p className="text-sm text-red-400">Error: {result.error}</p>
          ) : !result || result.groups.length === 0 ? (
            <p className="text-sm text-gray-500 italic">No clusters returned.</p>
          ) : (
            <>
              {result.groups.map(g => (
                <div key={g.cluster_id} className="rounded-lg border border-gray-800 bg-gray-950/40 p-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-semibold text-purple-200">
                      {g.brand} <span className="text-gray-500">·</span> {g.sub_product}
                    </h3>
                    <span className="text-[10px] text-gray-500">{g.total_impressions} imp · {g.members.length} q</span>
                  </div>
                  <p className="text-xs text-gray-300 mt-1">
                    Rep: <span className="font-medium text-white">{g.representative_query}</span>
                  </p>
                  <ul className="mt-1.5 space-y-0.5 text-[11px] text-gray-400">
                    {g.members.map((m, i) => <li key={i}>· {m}</li>)}
                  </ul>
                </div>
              ))}
              {result.unclustered.length > 0 && (
                <div className="rounded-lg border border-dashed border-gray-700 p-3 text-xs text-gray-500">
                  Unclustered ({result.unclustered.length}): {result.unclustered.join(' · ')}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
