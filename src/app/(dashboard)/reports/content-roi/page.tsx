'use client'

import { useState, useEffect, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClusterROI {
  id: string
  map_id: string
  map_topic: string
  map_market: string
  keyword: string
  url_slug: string
  suggested_title: string | null
  search_volume: number | null
  difficulty: number | null
  intent: string | null
  content_type: string | null
  cluster_group: string | null
  is_pillar: boolean
  published_at: string

  // GSC
  gsc_clicks: number
  gsc_impressions: number
  gsc_ctr: number
  gsc_position: number | null

  // GA4
  ga4_sessions: number
  ga4_engaged: number
  ga4_bounce_rate: number
  ga4_avg_duration: number
  ga4_views: number

  // Revenue
  revenue_landing: number
  transactions_landing: number
  sessions_landing: number
  revenue_on_page: number
  transactions_on_page: number

  // Computed
  rpc: number
  rps: number
}

interface Summary {
  totalPublished: number
  totalRevenueLanding: number
  totalRevenueOnPage: number
  totalClicks: number
  totalImpressions: number
  totalSessions: number
  totalTransactions: number
  topByRevenue: string | null
  topByClicks: string | null
  ga4Available: boolean
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtRevenue(n: number, currency = 'USD') {
  if (n === 0) return <span className="text-gray-700">—</span>
  if (currency === 'IDR' || n > 10000) {
    if (n >= 1_000_000_000) return <span className="text-green-400 font-semibold">${(n / 1_000_000_000).toFixed(1)}B</span>
    if (n >= 1_000_000)     return <span className="text-green-400 font-semibold">${(n / 1_000_000).toFixed(1)}M</span>
    if (n >= 1_000)         return <span className="text-green-400 font-semibold">${(n / 1_000).toFixed(1)}K</span>
  }
  return <span className="text-green-400 font-semibold">${n.toFixed(2)}</span>
}

function fmtRevStr(n: number) {
  if (n === 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function fmtNum(n: number) {
  if (!n) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function fmtPct(n: number) {
  if (!n) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function fmtDur(s: number) {
  if (!s) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

function posColor(p: number | null) {
  if (!p) return 'text-gray-600'
  if (p <= 3)  return 'text-green-400'
  if (p <= 10) return 'text-yellow-400'
  if (p <= 20) return 'text-orange-400'
  return 'text-gray-400'
}

// ── MiniBar ───────────────────────────────────────────────────────────────────
function MiniBar({ value, max, color = '#22c55e' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  )
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = 'text-white', icon }: {
  label: string; value: string; sub?: string; color?: string; icon: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">{icon}</span>
        <span className="text-gray-500 text-xs">{label}</span>
      </div>
      <p className={`text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Attribution Toggle ────────────────────────────────────────────────────────
function AttributionToggle({ model, onChange }: {
  model: 'landing' | 'on_page'
  onChange: (m: 'landing' | 'on_page') => void
}) {
  return (
    <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
      <button
        onClick={() => onChange('landing')}
        className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${model === 'landing' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
      >
        🛬 Landing page
      </button>
      <button
        onClick={() => onChange('on_page')}
        className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${model === 'on_page' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
      >
        📄 On-page
      </button>
    </div>
  )
}

// ── Date Range Presets ────────────────────────────────────────────────────────
const DATE_PRESETS = [
  { label: '7d',  start: '7daysAgo',  end: 'yesterday' },
  { label: '30d', start: '30daysAgo', end: 'yesterday' },
  { label: '90d', start: '90daysAgo', end: 'yesterday' },
]

type SortKey = 'revenue' | 'clicks' | 'sessions' | 'position' | 'transactions' | 'rpc'

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ContentROIPage() {
  const [clusters, setClusters]   = useState<ClusterROI[]>([])
  const [summary,  setSummary]    = useState<Summary | null>(null)
  const [loading,  setLoading]    = useState(true)
  const [error,    setError]      = useState('')

  const [preset,   setPreset]     = useState('30d')
  const [startDate, setStartDate] = useState('30daysAgo')
  const [endDate,   setEndDate]   = useState('yesterday')

  const [attribution, setAttribution] = useState<'landing' | 'on_page'>('landing')
  const [mapFilter,   setMapFilter]   = useState<string>('all')
  const [sortKey,     setSortKey]     = useState<SortKey>('revenue')
  const [sortDesc,    setSortDesc]    = useState(true)
  const [search,      setSearch]      = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ start: startDate, end: endDate })
      if (mapFilter !== 'all') params.set('map_id', mapFilter)
      const res  = await fetch(`/api/content-roi?${params}`)
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Failed to load'); return }
      setClusters(data.clusters ?? [])
      setSummary(data.summary ?? null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [startDate, endDate, mapFilter]) // eslint-disable-line

  // Unique maps for filter dropdown
  const maps = useMemo(() => {
    const seen = new Map<string, string>()
    for (const c of clusters) {
      if (!seen.has(c.map_id)) seen.set(c.map_id, c.map_topic)
    }
    return Array.from(seen.entries()).map(([id, topic]) => ({ id, topic }))
  }, [clusters])

  // Filtered + sorted
  const displayed = useMemo(() => {
    let list = clusters
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c =>
        c.keyword.toLowerCase().includes(q) ||
        c.map_topic.toLowerCase().includes(q) ||
        c.url_slug.toLowerCase().includes(q)
      )
    }

    const getRevenue = (c: ClusterROI) =>
      attribution === 'landing' ? c.revenue_landing : c.revenue_on_page
    const getTx = (c: ClusterROI) =>
      attribution === 'landing' ? c.transactions_landing : c.transactions_on_page

    return [...list].sort((a, b) => {
      let va = 0, vb = 0
      switch (sortKey) {
        case 'revenue':      va = getRevenue(a); vb = getRevenue(b); break
        case 'clicks':       va = a.gsc_clicks;  vb = b.gsc_clicks;  break
        case 'sessions':     va = a.ga4_sessions; vb = b.ga4_sessions; break
        case 'position':
          va = a.gsc_position ?? 999; vb = b.gsc_position ?? 999
          return sortDesc ? va - vb : vb - va   // lower position = better
        case 'transactions': va = getTx(a); vb = getTx(b); break
        case 'rpc':          va = a.rpc;    vb = b.rpc;    break
      }
      return sortDesc ? vb - va : va - vb
    })
  }, [clusters, search, sortKey, sortDesc, attribution])

  const maxRevenue = useMemo(() =>
    Math.max(...displayed.map(c => attribution === 'landing' ? c.revenue_landing : c.revenue_on_page), 1),
    [displayed, attribution]
  )
  const maxClicks = useMemo(() =>
    Math.max(...displayed.map(c => c.gsc_clicks), 1),
    [displayed]
  )

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDesc(d => !d)
    else { setSortKey(key); setSortDesc(true) }
  }

  function ThCol({ k, label, right = true }: { k: SortKey; label: string; right?: boolean }) {
    const active = sortKey === k
    return (
      <th
        onClick={() => toggleSort(k)}
        className={`py-3 px-3 text-xs font-medium cursor-pointer select-none transition ${right ? 'text-right' : 'text-left'} ${active ? 'text-white' : 'text-gray-500 hover:text-gray-300'}`}
      >
        {label}{active ? (sortDesc ? ' ↓' : ' ↑') : ''}
      </th>
    )
  }

  const revenue    = (c: ClusterROI) => attribution === 'landing' ? c.revenue_landing   : c.revenue_on_page
  const txCount    = (c: ClusterROI) => attribution === 'landing' ? c.transactions_landing : c.transactions_on_page

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-white font-bold text-xl">Content ROI</h1>
          <p className="text-gray-500 text-sm mt-1">
            Published keyword cluster performance — organic traffic + revenue attributed per page
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Date presets */}
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {DATE_PRESETS.map(p => (
              <button
                key={p.label}
                onClick={() => { setPreset(p.label); setStartDate(p.start); setEndDate(p.end) }}
                className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${preset === p.label ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >{p.label}</button>
            ))}
          </div>

          <AttributionToggle model={attribution} onChange={setAttribution} />

          <button
            onClick={load}
            disabled={loading}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition disabled:opacity-50"
          >
            {loading ? '⟳' : '↺'} Refresh
          </button>
        </div>
      </div>

      {/* Attribution notice */}
      <div className="mb-5 flex items-start gap-2 text-xs text-gray-600 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <span className="text-blue-500 flex-shrink-0">ℹ</span>
        {attribution === 'landing' ? (
          <span><span className="text-blue-400 font-medium">Landing page model</span> — revenue from organic sessions that started on this page and resulted in a purchase. Best for measuring SEO content impact.</span>
        ) : (
          <span><span className="text-yellow-400 font-medium">On-page model</span> — purchase events fired directly on this page path. Best for checkout/product pages with page-level purchase tracking.</span>
        )}
      </div>

      {error ? (
        <div className="bg-red-900/30 border border-red-700 rounded-xl px-5 py-4 text-red-300 text-sm">{error}</div>
      ) : loading ? (
        <div className="flex items-center justify-center py-24">
          <LottieLoader size={80} text="Pulling revenue data…" />
        </div>
      ) : (
        <>
          {/* KPI Cards */}
          {summary && (
            <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3 mb-6">
              <KpiCard
                icon="📄"
                label="Published pages"
                value={String(summary.totalPublished)}
                sub="from Keyword Map"
                color="text-white"
              />
              <KpiCard
                icon="💰"
                label={attribution === 'landing' ? 'Landing revenue' : 'On-page revenue'}
                value={fmtRevStr(attribution === 'landing' ? summary.totalRevenueLanding : summary.totalRevenueOnPage)}
                sub={`${summary.totalTransactions} transactions`}
                color="text-green-400"
              />
              <KpiCard
                icon="🖱️"
                label="GSC clicks"
                value={fmtNum(summary.totalClicks)}
                sub={`${fmtNum(summary.totalImpressions)} impressions`}
                color="text-blue-400"
              />
              <KpiCard
                icon="👥"
                label="Organic sessions"
                value={fmtNum(summary.totalSessions)}
                sub="GA4 organic"
                color="text-purple-400"
              />
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 col-span-2">
                <div className="flex items-center gap-2 mb-2">
                  <span>🏆</span>
                  <span className="text-gray-500 text-xs">Top by revenue</span>
                </div>
                <p className="text-white text-sm font-semibold truncate">{summary.topByRevenue ?? '—'}</p>
                <p className="text-gray-600 text-xs mt-0.5 truncate">Top by clicks: {summary.topByClicks ?? '—'}</p>
              </div>
            </div>
          )}

          {/* No GA4 warning */}
          {summary && !summary.ga4Available && (
            <div className="mb-4 bg-yellow-900/20 border border-yellow-800/50 rounded-lg px-4 py-2.5 text-yellow-400 text-xs">
              ⚠️ GA4 Property ID not configured — revenue data unavailable. GSC data (clicks/impressions) still works.
            </div>
          )}

          {/* Filters */}
          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search keyword or topic…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-60"
            />
            <select
              value={mapFilter}
              onChange={e => setMapFilter(e.target.value)}
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-red-500"
            >
              <option value="all">All topics</option>
              {maps.map(m => (
                <option key={m.id} value={m.id}>{m.topic}</option>
              ))}
            </select>
            <span className="text-gray-600 text-xs ml-auto">{displayed.length} pages</span>
          </div>

          {/* Table */}
          {displayed.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-16 text-center">
              <p className="text-2xl mb-2">📊</p>
              <p className="text-gray-400 text-sm font-medium">No published content yet</p>
              <p className="text-gray-600 text-xs mt-1">
                Mark keyword clusters as <span className="text-green-400">published</span> in the Keyword Map to track their ROI here
              </p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="border-b border-gray-800 bg-gray-800/40">
                  <tr>
                    <th className="py-3 px-4 text-left text-gray-500 font-medium">Page / Keyword</th>
                    <th className="py-3 px-3 text-left text-gray-500 font-medium">Topic</th>
                    <ThCol k="revenue"      label={attribution === 'landing' ? '💰 Revenue (LP)' : '💰 Revenue (OP)'} />
                    <ThCol k="transactions" label="Txn" />
                    <ThCol k="clicks"       label="Clicks" />
                    <th className="py-3 px-3 text-right text-gray-500 font-medium">Impr</th>
                    <th className="py-3 px-3 text-right text-gray-500 font-medium">CTR</th>
                    <ThCol k="position"     label="Pos" />
                    <ThCol k="sessions"     label="Sessions" />
                    <th className="py-3 px-3 text-right text-gray-500 font-medium">Engaged</th>
                    <th className="py-3 px-3 text-right text-gray-500 font-medium">Bounce</th>
                    <ThCol k="rpc"          label="$/click" />
                  </tr>
                </thead>
                <tbody>
                  {displayed.map(c => {
                    const rev = revenue(c)
                    const tx  = txCount(c)
                    return (
                      <tr key={c.id} className="border-t border-gray-800/60 hover:bg-gray-800/20 transition group">
                        {/* Keyword + slug */}
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-1.5">
                            {c.is_pillar && <span className="text-[10px] text-red-400">🏛️</span>}
                            <div>
                              <p className="text-gray-100 font-medium max-w-[220px] truncate">{c.keyword}</p>
                              <p className="text-gray-700 text-[10px] font-mono mt-0.5">/{c.url_slug}</p>
                            </div>
                          </div>
                        </td>

                        {/* Topic */}
                        <td className="py-3 px-3">
                          <div>
                            <p className="text-gray-400 truncate max-w-[100px]">{c.map_topic}</p>
                            <p className="text-gray-700 text-[10px]">{c.map_market.toUpperCase()}</p>
                          </div>
                        </td>

                        {/* Revenue */}
                        <td className="py-3 px-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            {fmtRevenue(rev)}
                            {rev > 0 && <MiniBar value={rev} max={maxRevenue} color="#22c55e" />}
                          </div>
                        </td>

                        {/* Transactions */}
                        <td className="py-3 px-3 text-right">
                          {tx > 0
                            ? <span className="text-green-400 font-semibold">{tx}</span>
                            : <span className="text-gray-700">—</span>}
                        </td>

                        {/* GSC clicks */}
                        <td className="py-3 px-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className={c.gsc_clicks ? 'text-blue-300' : 'text-gray-700'}>{fmtNum(c.gsc_clicks)}</span>
                            {c.gsc_clicks > 0 && <MiniBar value={c.gsc_clicks} max={maxClicks} color="#60a5fa" />}
                          </div>
                        </td>

                        {/* Impressions */}
                        <td className="py-3 px-3 text-right text-gray-500">{fmtNum(c.gsc_impressions)}</td>

                        {/* CTR */}
                        <td className="py-3 px-3 text-right text-gray-400">{fmtPct(c.gsc_ctr)}</td>

                        {/* Position */}
                        <td className="py-3 px-3 text-right">
                          <span className={`font-semibold tabular-nums ${posColor(c.gsc_position)}`}>
                            {c.gsc_position ? `#${c.gsc_position.toFixed(1)}` : '—'}
                          </span>
                        </td>

                        {/* Sessions */}
                        <td className="py-3 px-3 text-right text-gray-400">{fmtNum(c.ga4_sessions)}</td>

                        {/* Engaged */}
                        <td className="py-3 px-3 text-right text-gray-500">
                          {c.ga4_sessions > 0
                            ? fmtPct(c.ga4_engaged / c.ga4_sessions)
                            : '—'}
                        </td>

                        {/* Bounce */}
                        <td className="py-3 px-3 text-right">
                          {c.ga4_bounce_rate > 0
                            ? <span className={c.ga4_bounce_rate > 0.7 ? 'text-red-400' : 'text-gray-400'}>{fmtPct(c.ga4_bounce_rate)}</span>
                            : <span className="text-gray-700">—</span>}
                        </td>

                        {/* Revenue per click */}
                        <td className="py-3 px-3 text-right">
                          {c.rpc > 0
                            ? <span className="text-yellow-400 font-semibold">${c.rpc.toFixed(3)}</span>
                            : <span className="text-gray-700">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>

                {/* Footer totals */}
                <tfoot className="border-t border-gray-700 bg-gray-800/30">
                  <tr>
                    <td className="py-2.5 px-4 text-gray-400 font-semibold text-xs" colSpan={2}>
                      Totals ({displayed.length} pages)
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <span className="text-green-400 font-bold text-xs">
                        {fmtRevStr(displayed.reduce((s, c) => s + revenue(c), 0))}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right text-green-400 font-bold text-xs">
                      {displayed.reduce((s, c) => s + txCount(c), 0) || '—'}
                    </td>
                    <td className="py-2.5 px-3 text-right text-blue-300 font-bold text-xs">
                      {fmtNum(displayed.reduce((s, c) => s + c.gsc_clicks, 0))}
                    </td>
                    <td className="py-2.5 px-3 text-right text-gray-400 text-xs">
                      {fmtNum(displayed.reduce((s, c) => s + c.gsc_impressions, 0))}
                    </td>
                    <td colSpan={6} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
