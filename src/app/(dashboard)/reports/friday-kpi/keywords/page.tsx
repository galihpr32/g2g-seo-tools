'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

/**
 * Sprint FRIDAY.KPI.KW-BREAKDOWN.2 (338) —
 * /reports/friday-kpi/keywords sub-page.
 *
 * Surfaces the GA4 (revenue per landing page) × GSC (top queries per page)
 * join for the most-recently-completed Thu→Wed week, per brand. Internal-
 * only (auth required), manual Refresh button to re-fetch from Google.
 *
 * Sort default: Sessions desc (Galih's preference). Toggle to Revenue.
 */

interface BreakdownQuery {
  query:       string
  rank:        number | null
  clicks:      number
  impressions: number
}

interface BreakdownRow {
  page:         string
  sessions:     number
  transactions: number
  revenue:      number
  top_queries:  BreakdownQuery[]
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
type Site = typeof SITES[number]
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

export default function KeywordBreakdownPage() {
  const [site,    setSite]    = useState<Site>('g2g')
  const [sort,    setSort]    = useState<SortKey>('sessions')
  const [data,    setData]    = useState<Record<Site, ApiResponse | null>>({ g2g: null, offgamers: null })
  const [loading, setLoading] = useState<Record<Site, boolean>>({ g2g: false, offgamers: false })
  const [refreshing, setRefreshing] = useState<Record<Site, boolean>>({ g2g: false, offgamers: false })
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set())

  const active = data[site]
  const payload = active?.payload ?? null

  const rows = useMemo(() => {
    if (!payload) return []
    return payload.rows.slice().sort((a, b) =>
      sort === 'sessions'
        ? b.sessions - a.sessions || b.revenue - a.revenue
        : b.revenue - a.revenue || b.sessions - a.sessions,
    )
  }, [payload, sort])

  // Initial fetch (cached) for both brands so the tabs swap instantly.
  useEffect(() => {
    void (async () => {
      setLoading({ g2g: true, offgamers: true })
      const out: Record<Site, ApiResponse | null> = { g2g: null, offgamers: null }
      await Promise.all(SITES.map(async s => {
        try {
          const res = await fetch(`/api/reports/friday-kpi/keyword-breakdown?site=${s}`, { cache: 'no-store' })
          const j   = await res.json() as ApiResponse
          out[s] = j
        } catch (e) {
          out[s] = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      }))
      setData(out)
      setLoading({ g2g: false, offgamers: false })
    })()
  }, [])

  async function refresh(target: Site) {
    setRefreshing(r => ({ ...r, [target]: true }))
    try {
      const res = await fetch(`/api/reports/friday-kpi/keyword-breakdown`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ site_slug: target }),
      })
      const j = await res.json() as ApiResponse
      setData(d => ({ ...d, [target]: j }))
    } catch (e) {
      setData(d => ({ ...d, [target]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setRefreshing(r => ({ ...r, [target]: false }))
    }
  }

  function toggleExpand(page: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(page)) next.delete(page); else next.add(page)
      return next
    })
  }

  return (
    <main className="max-w-7xl mx-auto p-6">
      <Link href="/reports/friday-kpi" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">← Weekly Report</Link>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">📋 Keyword Breakdown</h1>
          <p className="text-sm text-gray-400">
            Landing pages with GA4 revenue and the top 5 organic queries that drove rank to that page (last completed Thu→Wed week).
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

      {/* Header bar: week + sort + refresh */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="text-xs text-gray-400">
          {payload ? (
            <>
              Window <strong className="text-white">{payload.week_start} → {payload.week_end}</strong>
              {' · '}
              Generated <strong className="text-white">{fmtRel(payload.generated_at)}</strong>
              {' · '}
              <span className="text-gray-500">
                GA4 rows: {payload.diagnostics.ga4_rows_fetched} · GSC rows: {payload.diagnostics.gsc_rows_fetched} · matched: {payload.diagnostics.matched_pages}
              </span>
            </>
          ) : active?.hint ? (
            <span className="text-amber-300/80">No snapshot for this week yet. Click <strong>Refresh</strong> to build one.</span>
          ) : active?.error ? (
            <span className="text-red-400">Error: {active.error}</span>
          ) : (
            <span className="text-gray-500">Loading…</span>
          )}
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
            onClick={() => refresh(site)}
            disabled={refreshing[site]}
            className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition inline-flex items-center gap-1"
          >
            {refreshing[site] ? '⏳ Refreshing…' : '↻ Refresh'}
          </button>
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
        {loading[site] ? (
          <div className="p-10 text-center text-gray-500 text-sm">Loading cached snapshot…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            {payload ? 'No rows for this week.' : 'No snapshot yet — click Refresh.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-950/80 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left  px-4 py-2 w-[44%]">Landing Page</th>
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
        Sessions/Tx/Revenue from GA4 (Organic Search only, sessionDefaultChannelGroup filter). Top queries from GSC, ranked by clicks within the same window. Each landing page&apos;s revenue is its total — queries shown are the top organic drivers but the table does <em>not</em> pro-rate revenue across queries (1 page can rank for many keywords).
      </p>
    </main>
  )
}

function RowGroup({ row, isOpen, onToggle }: { row: BreakdownRow; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="border-t border-gray-800 hover:bg-gray-900/60 transition cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2.5 font-mono text-[12px] text-gray-200 truncate max-w-0">
          <span className="text-gray-500 mr-1.5">{isOpen ? '▾' : '▸'}</span>
          {row.page}
        </td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-300">{fmtNum(row.sessions)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-400">{row.transactions || '—'}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-emerald-300 font-medium">{fmtMoney(row.revenue)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums text-gray-500 text-xs">
          {row.top_queries.length} {row.top_queries.length === 1 ? 'query' : 'queries'}
        </td>
      </tr>
      {isOpen && (
        <tr className="border-t border-gray-800 bg-gray-950/40">
          <td colSpan={5} className="px-4 py-3">
            {row.top_queries.length === 0 ? (
              <p className="text-xs text-gray-500 italic">No GSC queries matched this page in this window.</p>
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
                  {row.top_queries.map((q, i) => (
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
