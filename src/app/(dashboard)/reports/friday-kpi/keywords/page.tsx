'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

/**
 * Sprint FRIDAY.KPI.KW-BREAKDOWN.2 (338) + FRIDAY.KPI.KW.FILTERS (340) —
 * /reports/friday-kpi/keywords sub-page.
 *
 * Surfaces the GA4 (revenue per landing page) × GSC (top queries per page)
 * join for one Thu→Wed week, per brand. Internal-only (auth required),
 * manual Refresh button to re-fetch from Google.
 *
 * Filters (sprint 340):
 *   • Search box — match by page path substring
 *   • URL include — startsWith filter (e.g. "/categories" to focus product hubs)
 *   • Market — All / US / ID (server-side split per landing page)
 *   • Category — joined from product_tiers
 *   • Week picker — last 12 Thu→Wed weeks; load cached or refresh
 *
 * Sort: Sessions desc default, toggle Revenue.
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
  cached?:      boolean
  site_slug?:   string
  week_start?:  string
  generated_at?: string
  payload?:     BreakdownPayload
  hint?:        string
  warning?:     string
  error?:       string
}

const SITES = ['g2g', 'offgamers'] as const
type Site    = typeof SITES[number]
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
function fmtRel(iso: string): string {
  const ms  = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1)    return 'just now'
  if (min < 60)   return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24)    return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

/**
 * Last 12 Thu→Wed weeks ending at the most-recently-completed Wed.
 * UI dropdown options. Newest first.
 */
function listLast12WeekStarts(now: Date = new Date()): string[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const day = today.getDay()
  const daysSinceCompletedWed = day === 3 ? 7 : (day + 4) % 7 || 7
  const lastWed = new Date(today)
  lastWed.setDate(today.getDate() - daysSinceCompletedWed)
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const end = new Date(lastWed)
    end.setDate(lastWed.getDate() - i * 7)
    const start = new Date(end)
    start.setDate(end.getDate() - 6)
    out.push(start.toISOString().slice(0, 10))
  }
  return out  // newest → oldest
}

function fmtWeekLabel(weekStart: string): string {
  const d   = new Date(weekStart + 'T00:00:00Z')
  const end = new Date(d.getTime() + 6 * 86_400_000)
  const fmt = (x: Date) => `${x.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${x.getUTCDate()}`
  return `${fmt(d)} – ${fmt(end)}`
}

export default function KeywordBreakdownPage() {
  // Brand tab + sort
  const [site,    setSite]    = useState<Site>('g2g')
  const [sort,    setSort]    = useState<SortKey>('sessions')
  // Filters
  const [search,        setSearch]        = useState('')
  const [urlInclude,    setUrlInclude]    = useState('')
  const [market,        setMarket]        = useState<Market>('all')
  const [category,      setCategory]      = useState<string>('all')   // 'all' | category name | '__uncategorized__'
  const [weekStart,     setWeekStart]     = useState<string>(() => listLast12WeekStarts()[0])

  const weekOptions = useMemo(() => listLast12WeekStarts(), [])

  // Data per (site × weekStart) — keyed for cheap tab/week switching
  const [data, setData] = useState<Record<string, ApiResponse | null>>({})
  const [loading,    setLoading]    = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set())

  const cacheKey = `${site}::${weekStart}`
  const active   = data[cacheKey] ?? null
  const payload  = active?.payload ?? null

  // Auto-load when (site, weekStart) changes if we don't have it cached yet
  useEffect(() => {
    if (data[cacheKey] !== undefined) return
    void (async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/reports/friday-kpi/keyword-breakdown?site=${site}&week=${weekStart}`, { cache: 'no-store' })
        const j   = await res.json() as ApiResponse
        setData(d => ({ ...d, [cacheKey]: j }))
      } catch (e) {
        setData(d => ({ ...d, [cacheKey]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
      } finally {
        setLoading(false)
      }
    })()
  }, [cacheKey, site, weekStart, data])

  async function refresh() {
    setRefreshing(true)
    try {
      const res = await fetch(`/api/reports/friday-kpi/keyword-breakdown`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site_slug: site, week_start: weekStart }),
      })
      const j = await res.json() as ApiResponse
      setData(d => ({ ...d, [cacheKey]: j }))
    } catch (e) {
      setData(d => ({ ...d, [cacheKey]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setRefreshing(false)
    }
  }

  // ── Apply filters + sort ─────────────────────────────────────────────
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
      // Market: rows hide when slice has 0 sessions AND 0 queries (truly no signal in that market)
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
    setSearch('')
    setUrlInclude('')
    setMarket('all')
    setCategory('all')
  }

  const filtersActive = !!(search || urlInclude || market !== 'all' || category !== 'all')

  return (
    <main className="max-w-7xl mx-auto p-6">
      <Link href="/reports/friday-kpi" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">← Weekly Report</Link>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">📋 Keyword Breakdown</h1>
          <p className="text-sm text-gray-400">
            Landing pages with GA4 revenue and the top 5 organic queries that drove rank to that page (Thu→Wed weekly windows).
          </p>
        </div>
      </div>

      {/* Brand tabs */}
      <div className="inline-flex gap-1 bg-gray-900 border border-gray-800 rounded-lg p-1 mb-4">
        {SITES.map(s => (
          <button
            key={s}
            onClick={() => setSite(s)}
            className={`px-4 py-1.5 text-sm rounded-md transition ${
              site === s
                ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {s.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Header bar: week picker + meta + refresh */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-gray-500">Week:</label>
          <select
            value={weekStart}
            onChange={e => setWeekStart(e.target.value)}
            className="bg-gray-950 border border-gray-800 text-gray-200 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-violet-500"
          >
            {weekOptions.map((w, i) => (
              <option key={w} value={w}>
                {fmtWeekLabel(w)} {i === 0 ? '(latest)' : ''}
              </option>
            ))}
          </select>
          <span className="text-xs text-gray-500 ml-2">
            {payload ? (
              <>
                Generated <strong className="text-white">{fmtRel(payload.generated_at)}</strong>
                {' · '}
                <span className="text-gray-600">
                  GA4: {payload.diagnostics.ga4_rows_fetched} · GSC: {payload.diagnostics.gsc_rows_fetched} · matched: {payload.diagnostics.matched_pages}
                </span>
              </>
            ) : active?.hint ? (
              <span className="text-amber-300/80">No snapshot for this week — click Refresh.</span>
            ) : active?.error ? (
              <span className="text-red-400">Error: {active.error}</span>
            ) : loading ? (
              <span className="text-gray-500">Loading…</span>
            ) : null}
          </span>
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
            onClick={refresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition inline-flex items-center gap-1"
          >
            {refreshing ? '⏳ Refreshing…' : '↻ Refresh'}
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

      {/* Diagnostic warnings */}
      {payload?.diagnostics.ga4_error && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-200 text-xs p-3 mb-3">
          ⚠️ GA4: {payload.diagnostics.ga4_error}
        </div>
      )}
      {payload?.diagnostics.gsc_error && payload.diagnostics.gsc_error !== payload.diagnostics.ga4_error && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-200 text-xs p-3 mb-3">
          ⚠️ GSC: {payload.diagnostics.gsc_error}
        </div>
      )}
      {active?.warning && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-200 text-xs p-3 mb-3">
          ⚠️ {active.warning}
        </div>
      )}

      {/* Table */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-500 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            {payload ? (filtersActive ? 'No rows match the filters.' : 'No rows for this week.') : 'No snapshot yet — click Refresh.'}
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
        Sessions/Tx/Revenue from GA4 (Organic Search only). When market = US or ID, slice shows traffic where GA4&apos;s <code>country</code> dim matches that market. Top queries come from GSC filtered to the same country (idn = ID, else = US). Each landing page&apos;s revenue is total for that market — queries are the top organic drivers but the table does <em>not</em> pro-rate revenue across queries.
      </p>
    </main>
  )
}

function RowGroup({ row, market, isOpen, onToggle }: { row: BreakdownRow; market: Market; isOpen: boolean; onToggle: () => void }) {
  // Pick slice based on market filter
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
