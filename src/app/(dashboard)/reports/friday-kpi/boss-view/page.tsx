'use client'

/**
 * Sprint #361 WEEKLY.BOSS.VIEW — preview page for the new boss-spec weekly
 * report layout.
 *
 * Renders:
 *   - Chart 1: combo bars (traffic this wk vs last wk) + dashed lines
 *     (revenue) — 4 properties × 2 bars + 4 revenue lines on dual Y-axis
 *   - Chart 2 per brand: scatter with inverted Y (rank 1 at top), green
 *     band on rank 1–3, 4 dots per KW (US-LW hollow, US-TW solid, ID-LW
 *     hollow, ID-TW solid), thin connector line LW→TW
 *   - Two compact tables (one per brand) with top-5 focus KW
 *   - AI Source panel per brand (ChatGPT / Perplexity / Gemini / Claude /
 *     Copilot — users + revenue + WoW)
 *
 * Data comes from /api/reports/friday-kpi/boss-view (GET = cached, POST =
 * force-refresh). Chart.js loaded from CDN on mount.
 */

import { useEffect, useRef, useState } from 'react'

interface BossViewMarketSlice {
  thisWeek: number
  lastWeek: number
  pct:      number | null
}

interface FocusKeyword {
  keyword:        string
  brand:          string
  score:          number
  clicks:         number
  revenue:        number
  topLandingPage: string
  us: { lastWeek: number | null; thisWeek: number | null }
  id: { lastWeek: number | null; thisWeek: number | null }
}

interface BossViewBrand {
  siteSlug: string
  siteName: string
  traffic: { us: BossViewMarketSlice; id: BossViewMarketSlice }
  revenue: { us: BossViewMarketSlice; id: BossViewMarketSlice }
  focusKeywords: FocusKeyword[]
  diagnostics: {
    cluster_winner_count:  number
    gsc_queries_fetched:   number
    ga4_rev_pages_fetched: number
    kw_with_ga4_match:     number
    skip_reason?:          string
  }
}

interface AiSource {
  domain:       string
  label:        string
  users:        number
  sessions:     number
  revenue:      number
  prevUsers:    number
  prevSessions: number
  prevRevenue:  number
}

interface AiSiteSlice {
  sources:           AiSource[]
  totalUsers:        number
  totalSessions:     number
  totalRevenue:      number
  prevTotalUsers:    number
  prevTotalSessions: number
  prevTotalRevenue:  number
  skipReason?:       string
}

interface Payload {
  weekLabel:   string
  curStart:    string
  curEnd:      string
  prevStart:   string
  prevEnd:     string
  generatedAt: string
  brands:      BossViewBrand[]
  aiSource:    { bySite: Record<string, AiSiteSlice> }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Window { Chart?: any }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const COLORS = {
  g2gUS:  '#60a5fa',     // blue
  g2gID:  '#a78bfa',     // violet
  ogUS:   '#fb923c',     // orange
  ogID:   '#f87171',     // red
  good:   '#34d399',
  bad:    '#f87171',
  warn:   '#fbbf24',
  muted:  '#7b818f',
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n/1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n/1_000).toFixed(0)}K`
  return `$${Math.round(n)}`
}

function fmtPct(v: number | null): { text: string; color: string; emoji: string } {
  if (v == null)        return { text: '—',       color: COLORS.muted, emoji: '⚪' }
  if (Math.abs(v) < 1)  return { text: 'flat',    color: COLORS.muted, emoji: '🟡' }
  if (v > 0)            return { text: `+${v.toFixed(0)}%`, color: COLORS.good, emoji: '🟢' }
  return                       { text: `${v.toFixed(0)}%`,  color: COLORS.bad,  emoji: '🔴' }
}

function rankLight(rank: number | null): { color: string; emoji: string } {
  if (rank == null)   return { color: COLORS.muted, emoji: '⚪' }
  if (rank <= 3)      return { color: COLORS.good,  emoji: '🟢' }
  if (rank <= 10)     return { color: COLORS.warn,  emoji: '🟡' }
  return                     { color: COLORS.bad,   emoji: '🔴' }
}

function rankArrow(prev: number | null, cur: number | null): string {
  if (prev == null || cur == null) return ''
  if (cur < prev) return `▲${prev - cur}`      // lower rank num = better
  if (cur > prev) return `▼${cur - prev}`
  return '—'
}

// ─── Chart.js loader (CDN) ──────────────────────────────────────────────────

let chartLoadPromise: Promise<void> | null = null
function loadChartJs(): Promise<void> {
  if (typeof window !== 'undefined' && window.Chart) return Promise.resolve()
  if (chartLoadPromise) return chartLoadPromise
  chartLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src   = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
    script.async = true
    script.onload  = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Chart.js'))
    document.head.appendChild(script)
  })
  return chartLoadPromise
}

// ─── Charts ────────────────────────────────────────────────────────────────

interface ChartHandle { destroy(): void }

function makeChart1(canvas: HTMLCanvasElement, payload: Payload): ChartHandle | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Chart = window.Chart as any
  if (!Chart) return null

  // X axis: 4 property labels
  const labels = ['G2G-US', 'G2G-ID', 'OG-US', 'OG-ID']

  // Find each brand
  const g2g = payload.brands.find(b => b.siteSlug === 'g2g')
  const og  = payload.brands.find(b => b.siteSlug === 'offgamers')

  const thisWeek = [
    g2g?.traffic.us.thisWeek ?? 0,
    g2g?.traffic.id.thisWeek ?? 0,
    og?.traffic.us.thisWeek  ?? 0,
    og?.traffic.id.thisWeek  ?? 0,
  ]
  const lastWeek = [
    g2g?.traffic.us.lastWeek ?? 0,
    g2g?.traffic.id.lastWeek ?? 0,
    og?.traffic.us.lastWeek  ?? 0,
    og?.traffic.id.lastWeek  ?? 0,
  ]
  const revenueThisWeek = [
    g2g?.revenue.us.thisWeek ?? 0,
    g2g?.revenue.id.thisWeek ?? 0,
    og?.revenue.us.thisWeek  ?? 0,
    og?.revenue.id.thisWeek  ?? 0,
  ]
  const revenueLastWeek = [
    g2g?.revenue.us.lastWeek ?? 0,
    g2g?.revenue.id.lastWeek ?? 0,
    og?.revenue.us.lastWeek  ?? 0,
    og?.revenue.id.lastWeek  ?? 0,
  ]

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Traffic · This Week',
          data:  thisWeek,
          backgroundColor: COLORS.g2gUS + 'cc',
          borderColor:     COLORS.g2gUS,
          borderWidth:     1,
          yAxisID:         'y',
          order:           2,
        },
        {
          label: 'Traffic · Last Week',
          data:  lastWeek,
          backgroundColor: COLORS.muted + '66',
          borderColor:     COLORS.muted,
          borderWidth:     1,
          yAxisID:         'y',
          order:           3,
        },
        {
          type:  'line',
          label: 'Revenue · This Week ($)',
          data:  revenueThisWeek,
          borderColor:     COLORS.good,
          backgroundColor: COLORS.good + '33',
          borderDash:      [6, 4],
          borderWidth:     2,
          pointRadius:     4,
          pointBackgroundColor: COLORS.good,
          yAxisID:         'y1',
          tension:         0.25,
          order:           1,
        },
        {
          type:  'line',
          label: 'Revenue · Last Week ($)',
          data:  revenueLastWeek,
          borderColor:     COLORS.warn,
          backgroundColor: COLORS.warn + '22',
          borderDash:      [2, 4],
          borderWidth:     2,
          pointRadius:     3,
          pointBackgroundColor: COLORS.warn,
          yAxisID:         'y1',
          tension:         0.25,
          order:           0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { size: 11 } } },
        tooltip: {
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label: (ctx: any) => {
              const isRev = ctx.dataset.yAxisID === 'y1'
              const v = ctx.parsed.y as number
              return `${ctx.dataset.label}: ${isRev ? fmtUsd(v) : fmtNum(v)}`
            },
          },
        },
      },
      scales: {
        x: { ticks: { color: '#cbd5e1' }, grid: { color: 'rgba(148, 163, 184, 0.08)' } },
        y: {
          position: 'left',
          title: { display: true, text: 'Organic Traffic (clicks)', color: '#94a3b8' },
          ticks: { color: '#cbd5e1', callback: (v: number | string) => fmtNum(Number(v)) },
          grid:  { color: 'rgba(148, 163, 184, 0.08)' },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          title: { display: true, text: 'Organic Revenue ($)', color: '#94a3b8' },
          ticks: { color: '#cbd5e1', callback: (v: number | string) => fmtUsd(Number(v)) },
          grid:  { display: false },
          beginAtZero: true,
        },
      },
    },
  })
}

function makeChart2(
  canvas: HTMLCanvasElement,
  brand: BossViewBrand,
): ChartHandle | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Chart = window.Chart as any
  if (!Chart) return null

  const kws = brand.focusKeywords.slice(0, 5)
  if (kws.length === 0) return null

  // X: 1..5; we'll render labels separately. Each KW gets 4 points at the
  // same X (slightly jittered horizontally so dots don't overlap).
  const x = (idx: number, offset: number) => idx + 1 + offset

  const usLW = kws.map((k, i) => ({ x: x(i, -0.18), y: k.us.lastWeek ?? null }))
  const usTW = kws.map((k, i) => ({ x: x(i, -0.06), y: k.us.thisWeek ?? null }))
  const idLW = kws.map((k, i) => ({ x: x(i,  0.06), y: k.id.lastWeek ?? null }))
  const idTW = kws.map((k, i) => ({ x: x(i,  0.18), y: k.id.thisWeek ?? null }))

  // Connector lines LW→TW per market — separate datasets so they draw thin.
  const usConnectors = kws.flatMap((k, i) => {
    const a = k.us.lastWeek
    const b = k.us.thisWeek
    if (a == null || b == null) return []
    return [
      { x: x(i, -0.18), y: a },
      { x: x(i, -0.06), y: b },
      { x: NaN, y: NaN },  // break line between KW groups
    ]
  })
  const idConnectors = kws.flatMap((k, i) => {
    const a = k.id.lastWeek
    const b = k.id.thisWeek
    if (a == null || b == null) return []
    return [
      { x: x(i,  0.06), y: a },
      { x: x(i,  0.18), y: b },
      { x: NaN, y: NaN },
    ]
  })

  // Filter null points (Chart.js scatter handles them but we drop for clarity)
  const filter = <T extends { y: number | null }>(arr: T[]): T[] =>
    arr.filter(p => p.y != null) as T[]

  return new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        // Reference band: rank 1-3 zone (rendered via filled area between
        // two horizontal lines at y=0.5 and y=3.5 — Chart.js doesn't have
        // a native band so we approximate with a transparent dataset).
        {
          type:  'line',
          label: 'Top 3 zone',
          data: [
            { x: 0.5, y: 3.5 },
            { x: 5.5, y: 3.5 },
          ],
          borderColor:     'rgba(52, 211, 153, 0.6)',
          backgroundColor: 'rgba(52, 211, 153, 0.08)',
          borderDash:      [4, 4],
          borderWidth:     1,
          fill:            { target: { value: 0 } },
          pointRadius:     0,
          showLine:        true,
          order:           10,
        },
        // US connectors (thin grey)
        {
          type:  'line',
          label: 'US movement',
          data:  usConnectors,
          borderColor:     COLORS.g2gUS + '66',
          borderWidth:     1.5,
          pointRadius:     0,
          showLine:        true,
          spanGaps:        false,
          order:           5,
        },
        // ID connectors
        {
          type:  'line',
          label: 'ID movement',
          data:  idConnectors,
          borderColor:     COLORS.g2gID + '66',
          borderWidth:     1.5,
          pointRadius:     0,
          showLine:        true,
          spanGaps:        false,
          order:           5,
        },
        // US Last Week (hollow circle)
        {
          label:           'US · Last Week',
          data:            filter(usLW),
          backgroundColor: 'transparent',
          borderColor:     COLORS.g2gUS,
          borderWidth:     2,
          pointStyle:      'circle',
          pointRadius:     6,
          pointHoverRadius: 8,
          order:           2,
        },
        // US This Week (solid circle)
        {
          label:           'US · This Week',
          data:            filter(usTW),
          backgroundColor: COLORS.g2gUS,
          borderColor:     COLORS.g2gUS,
          pointStyle:      'circle',
          pointRadius:     6,
          pointHoverRadius: 8,
          order:           1,
        },
        // ID Last Week (hollow triangle)
        {
          label:           'ID · Last Week',
          data:            filter(idLW),
          backgroundColor: 'transparent',
          borderColor:     COLORS.g2gID,
          borderWidth:     2,
          pointStyle:      'triangle',
          pointRadius:     7,
          pointHoverRadius: 9,
          order:           2,
        },
        // ID This Week (solid triangle)
        {
          label:           'ID · This Week',
          data:            filter(idTW),
          backgroundColor: COLORS.g2gID,
          borderColor:     COLORS.g2gID,
          pointStyle:      'triangle',
          pointRadius:     7,
          pointHoverRadius: 9,
          order:           1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { color: '#cbd5e1', font: { size: 11 }, filter: (item: { text: string }) => !item.text.includes('movement') && item.text !== 'Top 3 zone' },
        },
        tooltip: {
          callbacks: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            label: (ctx: any) => {
              const idx = Math.floor(ctx.parsed.x - 1)
              const kw  = kws[idx]?.keyword ?? 'KW'
              return `${kw} — ${ctx.dataset.label}: #${ctx.parsed.y}`
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min:  0.5,
          max:  5.5,
          ticks: {
            color: '#cbd5e1',
            stepSize: 1,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callback: (v: any) => {
              const i = Number(v) - 1
              if (i < 0 || i >= kws.length || !Number.isInteger(Number(v))) return ''
              const kw = kws[i].keyword
              return kw.length > 18 ? kw.slice(0, 17) + '…' : kw
            },
          },
          grid: { color: 'rgba(148, 163, 184, 0.08)' },
        },
        y: {
          reverse:    true,                  // 1 at top, higher numbers below
          min:        1,
          suggestedMax: 20,
          title:      { display: true, text: 'Rank (1 = best)', color: '#94a3b8' },
          ticks:      { color: '#cbd5e1', stepSize: 1, callback: (v: number | string) => `#${v}` },
          grid:       { color: 'rgba(148, 163, 184, 0.08)' },
        },
      },
    },
  })
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BossViewPreviewPage() {
  const [payload,     setPayload]     = useState<Payload | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [cached,      setCached]      = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)

  const chart1Ref = useRef<HTMLCanvasElement>(null)
  const chart2gRef = useRef<HTMLCanvasElement>(null)
  const chart2oRef = useRef<HTMLCanvasElement>(null)
  const chartHandles = useRef<ChartHandle[]>([])

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function load(refresh = false) {
    if (refresh) setRefreshing(true)
    else         setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/friday-kpi/boss-view', {
        method: refresh ? 'POST' : 'GET',
        headers: refresh ? { 'Content-Type': 'application/json' } : undefined,
        body:    refresh ? JSON.stringify({ sites: ['g2g', 'offgamers'] }) : undefined,
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        const txt = (await res.text().catch(() => '')).slice(0, 300)
        setError(`HTTP ${res.status}: ${txt || 'unknown error'}`)
        return
      }
      const data = await res.json() as { cached?: boolean; payload?: Payload; generatedAt?: string; error?: string }
      if (data.error)      { setError(data.error); return }
      if (!data.payload)   { setError('No payload returned'); return }
      setPayload(data.payload)
      setCached(!!data.cached)
      setGeneratedAt(data.generatedAt ?? null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  // load() is stable enough — depends only on setState refs; deliberately
  // running once on mount.
  useEffect(() => { load(false) }, [])

  // ── Render charts ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!payload) return
    let canceled = false
    loadChartJs().then(() => {
      if (canceled) return
      // Destroy previous charts
      for (const h of chartHandles.current) h.destroy()
      chartHandles.current = []

      if (chart1Ref.current) {
        const h = makeChart1(chart1Ref.current, payload)
        if (h) chartHandles.current.push(h)
      }
      const g2g = payload.brands.find(b => b.siteSlug === 'g2g')
      const og  = payload.brands.find(b => b.siteSlug === 'offgamers')
      if (chart2gRef.current && g2g) {
        const h = makeChart2(chart2gRef.current, g2g)
        if (h) chartHandles.current.push(h)
      }
      if (chart2oRef.current && og) {
        const h = makeChart2(chart2oRef.current, og)
        if (h) chartHandles.current.push(h)
      }
    }).catch(err => {
      console.error('[boss-view] Chart.js load failed:', err)
      setError(`Chart.js load failed: ${err.message}`)
    })
    return () => { canceled = true }
  }, [payload])

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      <header className="flex items-start justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            🔍 Weekly Boss View
            <span className="text-xs px-2 py-0.5 bg-purple-700/30 text-purple-300 rounded font-normal">Preview</span>
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            {payload?.weekLabel ?? 'Loading…'}
            {generatedAt && (
              <span className="text-gray-600 ml-2">
                · {cached ? 'cached' : 'fresh'} {new Date(generatedAt).toLocaleString()}
              </span>
            )}
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing || loading}
          className="text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white px-3 py-2 rounded-lg transition font-medium"
        >
          {refreshing ? '⏳ Refreshing…' : '🔄 Refresh data'}
        </button>
      </header>

      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700/40 text-red-300 text-sm rounded-lg">
          {error}
        </div>
      )}

      {loading && !payload && (
        <div className="flex justify-center py-16 text-gray-500">Loading boss view…</div>
      )}

      {payload && (
        <>
          {/* ── Chart 1: Traffic + Revenue combo ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-white mb-1">
              📈 Organic Traffic &amp; Revenue — This Week vs Last Week
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              Bars (left axis) = clicks · Dashed lines (right axis) = revenue ($) ·
              Properties: G2G-US, G2G-ID, OG-US, OG-ID
            </p>
            <div className="h-80">
              <canvas ref={chart1Ref} />
            </div>
            {/* Metric strip */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 text-xs">
              {payload.brands.flatMap(b => (['us', 'id'] as const).map(m => {
                const t = b.traffic[m]
                const r = b.revenue[m]
                const tp = fmtPct(t.pct)
                const rp = fmtPct(r.pct)
                return (
                  <div key={`${b.siteSlug}-${m}`} className="bg-gray-950 border border-gray-800 rounded p-2.5">
                    <p className="text-gray-500 text-[10px] uppercase tracking-wider">{b.siteName}-{m.toUpperCase()}</p>
                    <p className="text-white font-mono mt-1">{fmtNum(t.thisWeek)} <span style={{ color: tp.color }}>{tp.emoji}{tp.text}</span></p>
                    <p className="text-emerald-300 font-mono text-[11px]">{fmtUsd(r.thisWeek)} <span style={{ color: rp.color }}>{rp.emoji}{rp.text}</span></p>
                  </div>
                )
              }))}
            </div>
          </section>

          {/* ── Per-brand: focus KW chart + table ── */}
          {payload.brands.map(brand => {
            const isG2g = brand.siteSlug === 'g2g'
            const ref   = isG2g ? chart2gRef : chart2oRef
            return (
              <section key={brand.siteSlug} className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
                <h2 className="text-sm font-semibold text-white mb-1">
                  🎯 {brand.siteName} — Top 5 Focus Keywords
                </h2>
                <p className="text-xs text-gray-500 mb-3">
                  Selected by composite z-score (organic clicks + landing-page revenue) over cluster_winners.
                  Hollow dot = last week, solid = this week. Y-axis inverted (rank 1 at top).
                </p>
                {brand.focusKeywords.length === 0 ? (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    {brand.diagnostics.skip_reason ?? 'No focus keywords for this brand this week'}
                  </div>
                ) : (
                  <>
                    <div className="h-80 mb-4">
                      <canvas ref={ref} />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-gray-500 uppercase tracking-wider text-[10px]">
                            <th className="text-left py-1.5 pr-3">Keyword</th>
                            <th className="text-right pr-3">Clicks (wk)</th>
                            <th className="text-right pr-3">Revenue (wk)</th>
                            <th className="text-right pr-3">US Rank</th>
                            <th className="text-right pr-3">ID Rank</th>
                            <th className="text-right">Score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {brand.focusKeywords.map(k => {
                            const usLight = rankLight(k.us.thisWeek)
                            const idLight = rankLight(k.id.thisWeek)
                            return (
                              <tr key={k.keyword} className="border-t border-gray-800 hover:bg-gray-950/40">
                                <td className="py-2 pr-3 text-white">
                                  <p className="font-medium">{k.keyword}</p>
                                  <p className="text-gray-600 text-[10px] truncate" title={k.topLandingPage}>{k.topLandingPage || '—'}</p>
                                </td>
                                <td className="text-right pr-3 text-gray-300 font-mono">{fmtNum(k.clicks)}</td>
                                <td className="text-right pr-3 text-gray-300 font-mono">{fmtUsd(k.revenue)}</td>
                                <td className="text-right pr-3 font-mono">
                                  <span style={{ color: usLight.color }}>
                                    {k.us.thisWeek != null ? `#${k.us.thisWeek}` : '—'}
                                    <span className="text-gray-500 ml-1">{rankArrow(k.us.lastWeek, k.us.thisWeek)}</span>
                                  </span>
                                </td>
                                <td className="text-right pr-3 font-mono">
                                  <span style={{ color: idLight.color }}>
                                    {k.id.thisWeek != null ? `#${k.id.thisWeek}` : '—'}
                                    <span className="text-gray-500 ml-1">{rankArrow(k.id.lastWeek, k.id.thisWeek)}</span>
                                  </span>
                                </td>
                                <td className="text-right text-gray-500 font-mono">{k.score.toFixed(2)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                <p className="text-[10px] text-gray-700 mt-3">
                  Diagnostics: {brand.diagnostics.cluster_winner_count} cluster_winners ·
                  {' '}{brand.diagnostics.gsc_queries_fetched} GSC rows ·
                  {' '}{brand.diagnostics.kw_with_ga4_match} KWs with GA4 revenue match
                </p>
              </section>
            )
          })}

          {/* ── AI Source panel ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-white mb-1">
              🤖 AI Source — ChatGPT · Perplexity · Gemini · Claude · Copilot
            </h2>
            <p className="text-xs text-gray-500 mb-3">
              GA4 sessions where the source domain is an AI assistant. Filtered to AI-domain whitelist
              regardless of whether the &quot;AI Source&quot; channel group is deployed to the property.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {payload.brands.map(brand => {
                const slice = payload.aiSource.bySite[brand.siteSlug]
                if (!slice) {
                  return (
                    <div key={brand.siteSlug} className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-gray-500">
                      {brand.siteName}: no AI source data
                    </div>
                  )
                }
                if (slice.skipReason) {
                  return (
                    <div key={brand.siteSlug} className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-gray-500">
                      <p className="font-semibold text-gray-400 mb-1">{brand.siteName}</p>
                      <p>⚠ {slice.skipReason}</p>
                    </div>
                  )
                }
                const usersPct    = fmtPct(slice.prevTotalUsers > 0 ? Math.round(((slice.totalUsers - slice.prevTotalUsers) / slice.prevTotalUsers) * 1000) / 10 : null)
                const revenuePct  = fmtPct(slice.prevTotalRevenue > 0 ? Math.round(((slice.totalRevenue - slice.prevTotalRevenue) / slice.prevTotalRevenue) * 1000) / 10 : null)
                return (
                  <div key={brand.siteSlug} className="bg-gray-950 border border-gray-800 rounded-lg p-4">
                    <div className="flex items-baseline justify-between mb-2">
                      <p className="font-semibold text-white text-sm">{brand.siteName}</p>
                      <p className="text-[10px] text-gray-500">{slice.sources.length} sources</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mb-3">
                      <div className="bg-gray-900 rounded p-2 text-xs">
                        <p className="text-gray-500 text-[10px] uppercase tracking-wider">AI Users</p>
                        <p className="text-white font-mono mt-1">{fmtNum(slice.totalUsers)} <span style={{ color: usersPct.color }}>{usersPct.text}</span></p>
                      </div>
                      <div className="bg-gray-900 rounded p-2 text-xs">
                        <p className="text-gray-500 text-[10px] uppercase tracking-wider">AI Revenue</p>
                        <p className="text-emerald-300 font-mono mt-1">{fmtUsd(slice.totalRevenue)} <span style={{ color: revenuePct.color }}>{revenuePct.text}</span></p>
                      </div>
                    </div>
                    <table className="w-full text-xs">
                      <thead className="text-gray-600 text-[10px] uppercase tracking-wider">
                        <tr>
                          <th className="text-left">Source</th>
                          <th className="text-right">Users</th>
                          <th className="text-right">Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {slice.sources.map(s => (
                          <tr key={s.label} className="border-t border-gray-800/60">
                            <td className="py-1 text-gray-300">{s.label}</td>
                            <td className="text-right text-gray-300 font-mono">{fmtNum(s.users)}</td>
                            <td className="text-right text-emerald-400 font-mono">{fmtUsd(s.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          </section>

          <p className="text-[10px] text-gray-600 text-center pb-4">
            Window: {payload.curStart} → {payload.curEnd} · prev: {payload.prevStart} → {payload.prevEnd}
          </p>
        </>
      )}
    </div>
  )
}
