'use client'

import { use, useEffect, useMemo, useState } from 'react'

/**
 * Sprint KW.BREAKDOWN.PUBLIC (350) —
 * /public/friday-kpi/keywords/[token] read-only public view.
 *
 * Mirrors the internal /reports/friday-kpi/keywords UI (filters, sort, expand)
 * but:
 *   • Fetches via /api/...?token=<token> which bypasses auth on the server
 *   • Locked to one (site × week) snapshot — no refresh, no week picker
 *   • No share/CSV buttons (management already has the link, they don't need
 *     to re-share). CSV export stays because exporting data is useful to
 *     management too.
 *
 * Filters + sort + expand all work the same as internal — management can
 * drill down. Read-only means they can't trigger a fresh Refresh call (that
 * stays gated to logged-in users).
 */

interface BreakdownQuery {
  query:       string
  rank:        number | null
  clicks:      number
  impressions: number
}
interface BreakdownMarketSlice {
  sessions:     number
  transactions: number
  revenue:      number
  top_queries:  BreakdownQuery[]
}
interface BreakdownRow {
  page:         string
  category:     string | null
  sessions:     number
  transactions: number
  revenue:      number
  top_queries:  BreakdownQuery[]
  us:           BreakdownMarketSlice
  id:           BreakdownMarketSlice
}
interface BreakdownPayload {
  site_slug:    string
  week_start:   string
  week_end:     string
  generated_at: string
  rows:         BreakdownRow[]
  diagnostics: {
    ga4_rows_fetched: number
    gsc_rows_fetched: number
    matched_pages:    number
    ga4_only_pages:   number
    gsc_only_pages:   number
    ga4_error?:       string
    gsc_error?:       string
  }
}
interface ApiResponse {
  ok:           boolean
  public?:      boolean
  site_slug?:   string
  week_start?:  string
  generated_at?: string
  payload?:     BreakdownPayload
  error?:       string
}

type Market  = 'all' | 'us' | 'id'
type SortKey = 'sessions' | 'revenue'

function fmtNum(n: number): string {
  if (n == null) return '—'
  return n.toLocaleString('en-US')
}
function fmtMoney(n: number): string {
  if (n == null || n === 0) return '—'
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtWeekLabel(weekStart: string): string {
  const d   = new Date(weekStart + 'T00:00:00Z')
  const end = new Date(d.getTime() + 6 * 86_400_000)
  const fmt = (x: Date) => `${x.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${x.getUTCDate()}`
  return `${fmt(d)} – ${fmt(end)}`
}

// CSV helpers (duplicate of internal page — keeping them inline so the public
// route is self-contained and doesn't reach into the dashboard tree).
function csvEscape(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (s === '') return ''
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
function buildCsv(rows: BreakdownRow[], market: Market): string {
  const header = ['Landing Page', 'Category', 'Sessions', 'Transactions', 'Revenue']
  for (let i = 1; i <= 5; i++) {
    header.push(`Q${i}`, `Q${i} Rank`, `Q${i} Clicks`, `Q${i} Impressions`)
  }
  const lines: string[] = [header.map(csvEscape).join(',')]
  for (const r of rows) {
    const slice = market === 'us' ? r.us : market === 'id' ? r.id : null
    const sessions     = slice ? slice.sessions     : r.sessions
    const transactions = slice ? slice.transactions : r.transactions
    const revenue      = slice ? slice.revenue      : r.revenue
    const queries      = slice ? slice.top_queries  : r.top_queries
    const row: (string | number)[] = [
      r.page,
      r.category ?? '',
      sessions,
      transactions,
      revenue.toFixed(2),
    ]
    for (let i = 0; i < 5; i++) {
      const q = queries[i]
      if (q) {
        row.push(q.query, q.rank ?? '', q.clicks, q.impressions)
      } else {
        row.push('', '', '', '')
      }
    }
    lines.push(row.map(csvEscape).join(','))
  }
  return lines.join('\r\n')
}
function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function PublicKeywordBreakdownPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)

  const [data,    setData]    = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const [sort,        setSort]        = useState<SortKey>('sessions')
  const [search,      setSearch]      = useState('')
  const [urlInclude,  setUrlInclude]  = useState('')
  const [market,      setMarket]      = useState<Market>('all')
  const [category,    setCategory]    = useState<string>('all')
  const [expanded,    setExpanded]    = useState<Set<string>>(new Set())

  useEffect(() => {
    void (async () => {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/reports/friday-kpi/keyword-breakdown?token=${encodeURIComponent(token)}`, { cache: 'no-store' })
        const j   = await res.json() as ApiResponse
        if (!res.ok || !j.ok) {
          setError(j.error ?? `HTTP ${res.status}`)
        } else {
          setData(j)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [token])

  const payload = data?.payload ?? null

  const allCategories = useMemo(() => {
    if (!payload) return [] as string[]
    const s = new Set<string>()
    for (const r of payload.rows) if (r.category) s.add(r.category)
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [payload])

  const rows = useMemo(() => {
    if (!payload) return [] as BreakdownRow[]
    const q   = search.trim().toLowerCase()
    const inc = urlInclude.trim().toLowerCase()
    const filtered = payload.rows.filter(r => {
      if (q   && !r.page.toLowerCase().includes(q))     return false
      if (inc && !r.page.toLowerCase().startsWith(inc)) return false
      if (category === '__uncategorized__' && r.category) return false
      if (category !== 'all' && category !== '__uncategorized__' && r.category !== category) return false
      if (market === 'us' && r.us.sessions === 0 && r.us.top_queries.length === 0) return false
      if (market === 'id' && r.id.sessions === 0 && r.id.top_queries.length === 0) return false
      return true
    })
    return filtered.sort((a, b) => {
      const aSlice = market === 'us' ? a.us : market === 'id' ? a.id : null
      const bSlice = market === 'us' ? b.us : market === 'id' ? b.id : null
      const aSess  = aSlice ? aSlice.sessions : a.sessions
      const bSess  = bSlice ? bSlice.sessions : b.sessions
      const aRev   = aSlice ? aSlice.revenue  : a.revenue
      const bRev   = bSlice ? bSlice.revenue  : b.revenue
      return sort === 'sessions'
        ? bSess - aSess || bRev - aRev
        : bRev  - aRev  || bSess - aSess
    })
  }, [payload, search, urlInclude, category, market, sort])

  function toggleExpand(page: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(page)) next.delete(page); else next.add(page)
      return next
    })
  }

  function clearFilters() {
    setSearch(''); setUrlInclude(''); setMarket('all'); setCategory('all')
  }

  function exportCsv() {
    if (!payload || rows.length === 0) return
    const csv      = buildCsv(rows, market)
    const filename = `kw-breakdown-${payload.site_slug}-${payload.week_start}${market === 'all' ? '' : '-' + market}.csv`
    downloadCsv(filename, csv)
  }

  const filtersActive = !!(search || urlInclude || market !== 'all' || category !== 'all')

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-950 text-gray-200 p-6">
        <div className="max-w-7xl mx-auto py-20 text-center text-gray-500 text-sm">Loading shared snapshot…</div>
      </main>
    )
  }

  if (error || !payload) {
    return (
      <main className="min-h-screen bg-gray-950 text-gray-200 p-6">
        <div className="max-w-3xl mx-auto py-20 text-center">
          <h1 className="text-2xl font-bold text-white mb-2">Snapshot not found</h1>
          <p className="text-sm text-gray-400">
            {error ?? 'This share link is invalid or has been rotated.'}
          </p>
          <p className="text-xs text-gray-600 mt-4">
            If you received this link from your team, ask them to refresh the snapshot and resend.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-200">
      <div className="max-w-7xl mx-auto p-6">
        <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">📋 Keyword Breakdown — {payload.site_slug.toUpperCase()}</h1>
            <p className="text-sm text-gray-400">
              Landing pages with GA4 revenue and the top 5 organic queries that drove rank to that page.
            </p>
            <p className="text-[11px] text-gray-600 mt-1">
              Window <strong className="text-gray-400">{fmtWeekLabel(payload.week_start)}</strong>
              {' · '}
              Generated <strong className="text-gray-400">{new Date(payload.generated_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
              {' · '}
              <span className="text-emerald-400/70">🔓 Public link</span>
            </p>
          </div>
        </div>

      {/* Header bar: sort + CSV */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 flex items-center justify-between flex-wrap gap-3">
        <div className="text-xs text-gray-500">
          GA4 rows: {payload.diagnostics.ga4_rows_fetched} · GSC rows: {payload.diagnostics.gsc_rows_fetched} · matched pages: {payload.diagnostics.matched_pages}
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex gap-1 bg-gray-950 border border-gray-800 rounded-lg p-1 text-xs">
            <button
              onClick={() => setSort('sessions')}
              className={`px-2.5 py-1 rounded-md ${sort === 'sessions' ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40' : 'text-gray-400 hover:text-gray-200'}`}
            >
              Sort: Sessions
            </button>
            <button
              onClick={() => setSort('revenue')}
              className={`px-2.5 py-1 rounded-md ${sort === 'revenue' ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/40' : 'text-gray-400 hover:text-gray-200'}`}
            >
              Sort: Revenue
            </button>
          </div>

          <button
            onClick={exportCsv}
            disabled={rows.length === 0}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition inline-flex items-center gap-1 border border-gray-700"
          >
            📥 Export CSV
          </button>
        </div>
      </section>

      {/* Filter bar */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-3 mb-4 grid grid-cols-1 md:grid-cols-12 gap-2">
        <div className="md:col-span-4 flex items-center gap-2">
          <span className="text-[10px] uppercase text-gray-500 shrink-0">Search</span>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="page path contains…"
            className="flex-1 bg-gray-950 border border-gray-800 text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-violet-500"
          />
        </div>
        <div className="md:col-span-3 flex items-center gap-2">
          <span className="text-[10px] uppercase text-gray-500 shrink-0">URL starts</span>
          <input
            type="text"
            value={urlInclude}
            onChange={e => setUrlInclude(e.target.value)}
            placeholder="/categories"
            className="flex-1 bg-gray-950 border border-gray-800 text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-violet-500"
          />
        </div>
        <div className="md:col-span-3 flex items-center gap-2">
          <span className="text-[10px] uppercase text-gray-500 shrink-0">Category</span>
          <select
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="flex-1 bg-gray-950 border border-gray-800 text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-violet-500"
          >
            <option value="all">All categories</option>
            <option value="__uncategorized__">— Uncategorized</option>
            {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="md:col-span-2 flex items-center justify-end gap-2">
          <div className="inline-flex gap-1 bg-gray-950 border border-gray-800 rounded-lg p-0.5 text-[11px]">
            {(['all', 'us', 'id'] as Market[]).map(m => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={`px-2 py-1 rounded-md ${market === m ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40' : 'text-gray-400 hover:text-gray-200'}`}
              >
                {m === 'all' ? 'All' : m === 'us' ? '🇺🇸 US' : '🇮🇩 ID'}
              </button>
            ))}
          </div>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="text-[11px] text-gray-500 hover:text-gray-300"
              title="Clear all filters"
            >
              clear
            </button>
          )}
        </div>
      </section>

      {/* Table */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            {filtersActive ? 'No rows match the filters.' : 'No rows in this snapshot.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-950/80 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left  px-4 py-2 w-[36%]">Landing Page</th>
                <th className="text-left  px-2 py-2 w-[10%]">Category</th>
                <th className="text-right px-4 py-2">Sessions</th>
                <th className="text-right px-4 py-2">Tx</th>
                <th className="text-right px-4 py-2">Revenue</th>
                <th className="text-right px-4 py-2">Top Queries</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const isOpen = expanded.has(r.page)
                return (
                  <RowGroup
                    key={r.page}
                    row={r}
                    market={market}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(r.page)}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-[11px] text-gray-600 italic mt-3">
        Sessions/Tx/Revenue from GA4 (Organic Search only). Per-market filter (US/ID) splits revenue and queries by GA4&apos;s <code>country</code> dim (idn = ID, else = US). Each landing page&apos;s revenue is total for that market — queries are the top organic drivers but the table does <em>not</em> pro-rate revenue across queries.
      </p>
      </div>
    </main>
  )
}

function RowGroup({ row, market, isOpen, onToggle }: { row: BreakdownRow; market: Market; isOpen: boolean; onToggle: () => void }) {
  const slice = market === 'us' ? row.us : market === 'id' ? row.id : null
  const sessions     = slice ? slice.sessions     : row.sessions
  const transactions = slice ? slice.transactions : row.transactions
  const revenue      = slice ? slice.revenue      : row.revenue
  const queries      = slice ? slice.top_queries  : row.top_queries
  return (
    <>
      <tr className="border-t border-gray-800 hover:bg-gray-900/60 transition cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2.5 font-mono text-[12px] text-gray-200 truncate max-w-0">
          <span className="text-gray-500 mr-1.5">{isOpen ? '▾' : '▸'}</span>
          {row.page}
        </td>
        <td className="px-2 py-2.5 text-[11px] text-gray-400 truncate max-w-0">
          {row.category ?? <span className="text-gray-600 italic">—</span>}
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-300">{fmtNum(sessions)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{transactions || '—'}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-emerald-300 font-medium">{fmtMoney(revenue)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 text-xs">
          {queries.length} {queries.length === 1 ? 'query' : 'queries'}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-gray-800 bg-gray-950/40">
          <td colSpan={6} className="px-4 py-3">
            {queries.length === 0 ? (
              <p className="text-xs text-gray-500 italic">
                No GSC queries matched this page in {market === 'all' ? 'this window' : `the ${market.toUpperCase()} market`}.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-gray-600">
                  <tr>
                    <th className="text-left  px-2 py-1">Query</th>
                    <th className="text-right px-2 py-1 w-16">Rank</th>
                    <th className="text-right px-2 py-1 w-20">Clicks</th>
                    <th className="text-right px-2 py-1 w-24">Impressions</th>
                  </tr>
                </thead>
                <tbody>
                  {queries.map((q, i) => (
                    <tr key={i} className="border-t border-gray-800/60">
                      <td className="px-2 py-1 text-gray-200 truncate max-w-0">{q.query}</td>
                      <td className="px-2 py-1 text-right text-gray-400 tabular-nums">{q.rank == null ? '—' : `#${q.rank}`}</td>
                      <td className="px-2 py-1 text-right text-gray-300 tabular-nums">{fmtNum(q.clicks)}</td>
                      <td className="px-2 py-1 text-right text-gray-400 tabular-nums">{fmtNum(q.impressions)}</td>
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
}
