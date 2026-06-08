'use client'

/**
 * Sprint #361 / Sprint #363 — Weekly Boss View preview page.
 *
 * Renders (top-to-bottom):
 *   1. KPI strip — 4 tiles, one per brand-country, this-week + WoW%
 *   2. 4 historical timeline charts (2×2 grid) — Jan 1 → now, weekly clicks
 *      bars + revenue line per brand-country
 *   3. Per-brand focus KW sections:
 *        - G2G: TWO tables (US focus + ID focus, 5 KW each, scored within
 *          market) + one scatter chart per market
 *        - OG: ONE table (5 KW, US+ID combined) + one scatter chart
 *      All scatter charts have inverted Y axis (rank 1 at top), green band
 *      for rank 1-3, hollow dot = last week, solid = this week, connector
 *      line LW→TW.
 *   4. AI Source panel per brand (ChatGPT / Perplexity / Gemini / Claude /
 *     Copilot — users + revenue + WoW)
 *   5. Slack Post Preview — monospace block showing what would post.
 *
 * Data comes from /api/reports/friday-kpi/boss-view. Chart.js via CDN.
 */

import { useEffect, useRef, useState } from 'react'

// ─── Types (mirror boss-view.ts) ────────────────────────────────────────────

interface BossViewMarketSlice {
  thisWeek: number
  lastWeek: number
  pct:      number | null
}

interface HistoricalBucket {
  weekEnd: string
  clicks:  number
  revenue: number
}

interface FocusKeyword {
  keyword:        string
  brand:          string
  scope:          'us' | 'id' | 'all'
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
  traffic:  { us: BossViewMarketSlice; id: BossViewMarketSlice }
  revenue:  { us: BossViewMarketSlice; id: BossViewMarketSlice }
  historical: { us: HistoricalBucket[]; id: HistoricalBucket[] }
  focusKeywordsUs?: FocusKeyword[]
  focusKeywordsId?: FocusKeyword[]
  focusKeywords?:   FocusKeyword[]
  diagnostics: {
    cluster_winner_count:  number
    gsc_queries_fetched:   number
    ga4_rev_pages_fetched: number
    kw_with_ga4_match:     number
    historical_weeks:      number
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
  g2gUS:  '#60a5fa',
  g2gID:  '#a78bfa',
  ogUS:   '#fb923c',
  ogID:   '#f87171',
  good:   '#34d399',
  bad:    '#f87171',
  warn:   '#fbbf24',
  muted:  '#7b818f',
}

const BRAND_COUNTRY_COLOR: Record<string, string> = {
  'g2g-us':       COLORS.g2gUS,
  'g2g-id':       COLORS.g2gID,
  'offgamers-us': COLORS.ogUS,
  'offgamers-id': COLORS.ogID,
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n/1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString()
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
  if (rank == null) return { color: COLORS.muted, emoji: '⚪' }
  if (rank <= 3)    return { color: COLORS.good,  emoji: '🟢' }
  if (rank <= 10)   return { color: COLORS.warn,  emoji: '🟡' }
  return                   { color: COLORS.bad,   emoji: '🔴' }
}

function rankArrow(prev: number | null, cur: number | null): string {
  if (prev == null || cur == null) return ''
  if (cur < prev) return `▲${prev - cur}`
  if (cur > prev) return `▼${cur - prev}`
  return '—'
}

function shortWeekLabel(ymd: string): string {
  // 2026-06-04 → "Jun 4"
  const d = new Date(ymd + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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

// ─── Chart 1 group: per-brand-country historical timeline ──────────────────

interface ChartHandle { destroy(): void }

function makeHistoricalChart(
  canvas:  HTMLCanvasElement,
  buckets: HistoricalBucket[],
  key:     string,        // e.g. 'g2g-us'
): ChartHandle | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Chart = window.Chart as any
  if (!Chart) return null

  const color = BRAND_COUNTRY_COLOR[key] ?? COLORS.muted
  const labels  = buckets.map(b => shortWeekLabel(b.weekEnd))
  const clicks  = buckets.map(b => b.clicks)
  const revenue = buckets.map(b => b.revenue)

  return new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Organic Clicks',
          data:  clicks,
          backgroundColor: color + 'aa',
          borderColor:     color,
          borderWidth:     1,
          yAxisID:         'y',
          order:           2,
        },
        {
          type: 'line',
          label: 'Organic Revenue ($)',
          data:  revenue,
          borderColor:     COLORS.good,
          backgroundColor: COLORS.good + '22',
          borderWidth:     2,
          pointRadius:     2,
          pointHoverRadius: 4,
          tension:         0.25,
          yAxisID:         'y1',
          order:           1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#cbd5e1', font: { size: 10 } } },
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
        x: {
          ticks: {
            color: '#94a3b8',
            font: { size: 9 },
            // Show every 4th tick to avoid crowding
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            callback: function (this: any, _v: number | string, idx: number) {
              return idx % 4 === 0 ? this.getLabelForValue(idx) : ''
            },
          },
          grid: { color: 'rgba(148, 163, 184, 0.06)' },
        },
        y: {
          position: 'left',
          title: { display: false },
          ticks: { color: '#cbd5e1', font: { size: 9 }, callback: (v: number | string) => fmtNum(Number(v)) },
          grid:  { color: 'rgba(148, 163, 184, 0.06)' },
          beginAtZero: true,
        },
        y1: {
          position: 'right',
          title: { display: false },
          ticks: { color: '#cbd5e1', font: { size: 9 }, callback: (v: number | string) => fmtUsd(Number(v)) },
          grid:  { display: false },
          beginAtZero: true,
        },
      },
    },
  })
}

// ─── Chart 2: scatter rank chart, per scope ────────────────────────────────

function makeScatter(
  canvas:  HTMLCanvasElement,
  kws:     FocusKeyword[],
  scope:   'us' | 'id' | 'all',
): ChartHandle | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Chart = window.Chart as any
  if (!Chart) return null

  if (kws.length === 0) return null

  // Determine which markets to plot. For G2G US focus list we only plot US
  // dots; for G2G ID list only ID dots; for OG we plot both.
  const showUs = scope === 'us' || scope === 'all'
  const showId = scope === 'id' || scope === 'all'

  const x = (idx: number, offset: number) => idx + 1 + offset

  // For single-market view we center the dots; for combined we keep the
  // original offsets so US and ID don't overlap.
  const offUsLw = scope === 'all' ? -0.18 : -0.10
  const offUsTw = scope === 'all' ? -0.06 : +0.10
  const offIdLw = +0.06
  const offIdTw = +0.18

  const usLW = kws.map((k, i) => ({ x: x(i, offUsLw), y: k.us.lastWeek ?? null }))
  const usTW = kws.map((k, i) => ({ x: x(i, offUsTw), y: k.us.thisWeek ?? null }))
  const idLW = kws.map((k, i) => ({ x: x(i, offIdLw), y: k.id.lastWeek ?? null }))
  const idTW = kws.map((k, i) => ({ x: x(i, offIdTw), y: k.id.thisWeek ?? null }))

  const usConnectors = showUs ? kws.flatMap((k, i) => {
    const a = k.us.lastWeek
    const b = k.us.thisWeek
    if (a == null || b == null) return []
    return [
      { x: x(i, offUsLw), y: a },
      { x: x(i, offUsTw), y: b },
      { x: NaN, y: NaN },
    ]
  }) : []
  const idConnectors = showId ? kws.flatMap((k, i) => {
    const a = k.id.lastWeek
    const b = k.id.thisWeek
    if (a == null || b == null) return []
    return [
      { x: x(i, offIdLw), y: a },
      { x: x(i, offIdTw), y: b },
      { x: NaN, y: NaN },
    ]
  }) : []

  const filter = <T extends { y: number | null }>(arr: T[]): T[] =>
    arr.filter(p => p.y != null) as T[]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const datasets: any[] = [
    {
      type:  'line',
      label: 'Top 3 zone',
      data: [{ x: 0.5, y: 3.5 }, { x: 5.5, y: 3.5 }],
      borderColor:     'rgba(52, 211, 153, 0.6)',
      backgroundColor: 'rgba(52, 211, 153, 0.08)',
      borderDash:      [4, 4],
      borderWidth:     1,
      fill:            { target: { value: 0 } },
      pointRadius:     0,
      showLine:        true,
      order:           10,
    },
  ]

  if (showUs) {
    datasets.push(
      { type: 'line', label: 'US movement', data: usConnectors, borderColor: COLORS.g2gUS + '66', borderWidth: 1.5, pointRadius: 0, showLine: true, spanGaps: false, order: 5 },
      { label: 'US · Last Week', data: filter(usLW), backgroundColor: 'transparent', borderColor: COLORS.g2gUS, borderWidth: 2, pointStyle: 'circle', pointRadius: 6, pointHoverRadius: 8, order: 2 },
      { label: 'US · This Week', data: filter(usTW), backgroundColor: COLORS.g2gUS, borderColor: COLORS.g2gUS, pointStyle: 'circle', pointRadius: 6, pointHoverRadius: 8, order: 1 },
    )
  }
  if (showId) {
    datasets.push(
      { type: 'line', label: 'ID movement', data: idConnectors, borderColor: COLORS.g2gID + '66', borderWidth: 1.5, pointRadius: 0, showLine: true, spanGaps: false, order: 5 },
      { label: 'ID · Last Week', data: filter(idLW), backgroundColor: 'transparent', borderColor: COLORS.g2gID, borderWidth: 2, pointStyle: 'triangle', pointRadius: 7, pointHoverRadius: 9, order: 2 },
      { label: 'ID · This Week', data: filter(idTW), backgroundColor: COLORS.g2gID, borderColor: COLORS.g2gID, pointStyle: 'triangle', pointRadius: 7, pointHoverRadius: 9, order: 1 },
    )
  }

  return new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#cbd5e1',
            font: { size: 10 },
            filter: (item: { text: string }) => !item.text.includes('movement') && item.text !== 'Top 3 zone',
          },
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
          reverse:    true,
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

// ─── Slack post preview builder ────────────────────────────────────────────

function buildSlackPostPreview(payload: Payload): string {
  const lines: string[] = []
  const sep = '━'.repeat(60)
  const weekRange = `${shortWeekLabel(payload.curStart)}–${shortWeekLabel(payload.curEnd)}`

  lines.push(sep)
  lines.push(`🔍  SEO  |  ${payload.weekLabel.split('·')[0].trim()}  ·  ${weekRange}`)
  lines.push(sep)

  // Metric table
  const g2g = payload.brands.find(b => b.siteSlug === 'g2g')
  const og  = payload.brands.find(b => b.siteSlug === 'offgamers')

  const pad = (s: string, w: number) => s.length >= w ? s : s + ' '.repeat(w - s.length)
  const fmtCell = (v: number, isUsd: boolean) => isUsd ? fmtUsd(v) : fmtNum(v)
  const fmtPctCell = (v: number | null) => {
    const f = fmtPct(v)
    return `${f.emoji}${f.text}`
  }

  lines.push('')
  lines.push(pad('Metric', 18) + pad('G2G-US', 14) + pad('WoW', 11) + pad('G2G-ID', 12) + pad('WoW', 11) + pad('OG-US', 12) + pad('WoW', 11) + pad('OG-ID', 11) + 'WoW')
  lines.push('─'.repeat(110))
  // Sprint #371 — defensive: an old cached row may have brand.traffic /
  // brand.revenue undefined or missing the per-market shape. Substitute
  // zero/null placeholders so render doesn't crash. Click Refresh data to
  // get a fresh cache built with the current shape.
  const safe = (slice: BossViewMarketSlice | undefined): BossViewMarketSlice =>
    slice ?? { thisWeek: 0, lastWeek: 0, pct: null }
  const t = (b: BossViewBrand | undefined, m: 'us' | 'id') => safe(b?.traffic?.[m])
  const r = (b: BossViewBrand | undefined, m: 'us' | 'id') => safe(b?.revenue?.[m])
  if (g2g && og) {
    lines.push(
      pad('Organic Traffic', 18) +
      pad(fmtCell(t(g2g, 'us').thisWeek, false), 14) + pad(fmtPctCell(t(g2g, 'us').pct), 11) +
      pad(fmtCell(t(g2g, 'id').thisWeek, false), 12) + pad(fmtPctCell(t(g2g, 'id').pct), 11) +
      pad(fmtCell(t(og,  'us').thisWeek, false), 12) + pad(fmtPctCell(t(og,  'us').pct), 11) +
      pad(fmtCell(t(og,  'id').thisWeek, false), 11) + fmtPctCell(t(og,  'id').pct)
    )
    lines.push(
      pad('Organic Revenue', 18) +
      pad(fmtCell(r(g2g, 'us').thisWeek, true), 14) + pad(fmtPctCell(r(g2g, 'us').pct), 11) +
      pad(fmtCell(r(g2g, 'id').thisWeek, true), 12) + pad(fmtPctCell(r(g2g, 'id').pct), 11) +
      pad(fmtCell(r(og,  'us').thisWeek, true), 12) + pad(fmtPctCell(r(og,  'us').pct), 11) +
      pad(fmtCell(r(og,  'id').thisWeek, true), 11) + fmtPctCell(r(og,  'id').pct)
    )
  }

  // Per-brand focus KW
  if (g2g?.focusKeywordsUs && g2g.focusKeywordsUs.length > 0) {
    lines.push('')
    lines.push('🎯 G2G — Top 5 Focus Keywords (US market)')
    lines.push(pad('Keyword', 35) + pad('Rank', 12) + 'WoW')
    for (const k of g2g.focusKeywordsUs) {
      const r = k.us.thisWeek != null ? `#${k.us.thisWeek}` : '—'
      const a = rankArrow(k.us.lastWeek, k.us.thisWeek)
      const light = rankLight(k.us.thisWeek)
      lines.push(pad(k.keyword.slice(0, 33), 35) + pad(r, 12) + `${a} ${light.emoji}`)
    }
  }
  if (g2g?.focusKeywordsId && g2g.focusKeywordsId.length > 0) {
    lines.push('')
    lines.push('🎯 G2G — Top 5 Focus Keywords (ID market)')
    lines.push(pad('Keyword', 35) + pad('Rank', 12) + 'WoW')
    for (const k of g2g.focusKeywordsId) {
      const r = k.id.thisWeek != null ? `#${k.id.thisWeek}` : '—'
      const a = rankArrow(k.id.lastWeek, k.id.thisWeek)
      const light = rankLight(k.id.thisWeek)
      lines.push(pad(k.keyword.slice(0, 33), 35) + pad(r, 12) + `${a} ${light.emoji}`)
    }
  }
  if (og?.focusKeywords && og.focusKeywords.length > 0) {
    lines.push('')
    lines.push('🎯 OffGamers — Top 5 Focus Keywords (US + ID)')
    lines.push(pad('Keyword', 35) + pad('US Rank', 11) + pad('ID Rank', 11) + 'WoW')
    for (const k of og.focusKeywords) {
      const ru = k.us.thisWeek != null ? `#${k.us.thisWeek}` : '—'
      const ri = k.id.thisWeek != null ? `#${k.id.thisWeek}` : '—'
      // Pick the better of the two markets for the WoW arrow
      const bestPrev = k.us.lastWeek != null && (k.id.lastWeek == null || k.us.lastWeek <= k.id.lastWeek)
        ? k.us.lastWeek : k.id.lastWeek
      const bestCur  = k.us.thisWeek != null && (k.id.thisWeek == null || k.us.thisWeek <= k.id.thisWeek)
        ? k.us.thisWeek : k.id.thisWeek
      const a = rankArrow(bestPrev, bestCur)
      lines.push(pad(k.keyword.slice(0, 33), 35) + pad(ru, 11) + pad(ri, 11) + a)
    }
  }

  // AI source
  lines.push('')
  lines.push('🤖 AI Search (organic citations from AI assistants)')
  for (const brand of payload.brands) {
    const slice = payload.aiSource.bySite[brand.siteSlug]
    if (!slice || slice.skipReason) continue
    lines.push(`  ${brand.siteName}: ${fmtNum(slice.totalUsers)} users · ${fmtUsd(slice.totalRevenue)} revenue`)
    for (const s of slice.sources.slice(0, 5)) {
      const usersDelta = s.prevUsers > 0 ? Math.round(((s.users - s.prevUsers) / s.prevUsers) * 100) : null
      const ud = usersDelta == null ? '' : (usersDelta > 0 ? ` (+${usersDelta}%)` : ` (${usersDelta}%)`)
      lines.push(`    ${pad(s.label, 14)} ${pad(fmtNum(s.users) + ud, 18)} ${fmtUsd(s.revenue)}`)
    }
  }

  lines.push('')
  lines.push('📈 [4 historical timeline charts attached as PNG]')
  lines.push('📈 [3 scatter rank charts attached as PNG]')
  lines.push('')
  lines.push('📝 Commentary')
  lines.push('  ✅ Why it worked:  [TBD — auto-fill from action-plan synthesizer]')
  lines.push('  🔧 Action taken:   [TBD — auto-fill from action-plan synthesizer]')
  lines.push(sep)
  return lines.join('\n')
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BossViewPreviewPage() {
  const [payload,     setPayload]     = useState<Payload | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [refreshing,  setRefreshing]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [cached,      setCached]      = useState(false)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [copyOk,      setCopyOk]      = useState(false)

  // 4 historical chart canvases (one per brand-country)
  const histRefs = {
    g2gUs: useRef<HTMLCanvasElement>(null),
    g2gId: useRef<HTMLCanvasElement>(null),
    ogUs:  useRef<HTMLCanvasElement>(null),
    ogId:  useRef<HTMLCanvasElement>(null),
  }
  // 3 scatter charts
  const scatterRefs = {
    g2gUs: useRef<HTMLCanvasElement>(null),
    g2gId: useRef<HTMLCanvasElement>(null),
    og:    useRef<HTMLCanvasElement>(null),
  }
  const chartHandles = useRef<ChartHandle[]>([])

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
      if (data.error)    { setError(data.error); return }
      if (!data.payload) { setError('No payload returned'); return }
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

  useEffect(() => { load(false) }, [])

  // Render all charts
  useEffect(() => {
    if (!payload) return
    let canceled = false
    loadChartJs().then(() => {
      if (canceled) return
      for (const h of chartHandles.current) h.destroy()
      chartHandles.current = []

      const g2g = payload.brands.find(b => b.siteSlug === 'g2g')
      const og  = payload.brands.find(b => b.siteSlug === 'offgamers')

      // Sprint #367 — old cached rows from before Sprint #363 may not have
      // `historical` field. Default to empty array buckets so chart renders
      // empty rather than crashing with "Cannot read properties of undefined".
      const histOrEmpty = (b: BossViewBrand | undefined): { us: HistoricalBucket[]; id: HistoricalBucket[] } =>
        b?.historical ?? { us: [], id: [] }

      // Historical timelines
      if (histRefs.g2gUs.current && g2g) {
        const h = makeHistoricalChart(histRefs.g2gUs.current, histOrEmpty(g2g).us, 'g2g-us')
        if (h) chartHandles.current.push(h)
      }
      if (histRefs.g2gId.current && g2g) {
        const h = makeHistoricalChart(histRefs.g2gId.current, histOrEmpty(g2g).id, 'g2g-id')
        if (h) chartHandles.current.push(h)
      }
      if (histRefs.ogUs.current && og) {
        const h = makeHistoricalChart(histRefs.ogUs.current, histOrEmpty(og).us, 'offgamers-us')
        if (h) chartHandles.current.push(h)
      }
      if (histRefs.ogId.current && og) {
        const h = makeHistoricalChart(histRefs.ogId.current, histOrEmpty(og).id, 'offgamers-id')
        if (h) chartHandles.current.push(h)
      }

      // Scatter charts
      if (scatterRefs.g2gUs.current && g2g?.focusKeywordsUs) {
        const h = makeScatter(scatterRefs.g2gUs.current, g2g.focusKeywordsUs, 'us')
        if (h) chartHandles.current.push(h)
      }
      if (scatterRefs.g2gId.current && g2g?.focusKeywordsId) {
        const h = makeScatter(scatterRefs.g2gId.current, g2g.focusKeywordsId, 'id')
        if (h) chartHandles.current.push(h)
      }
      if (scatterRefs.og.current && og?.focusKeywords) {
        const h = makeScatter(scatterRefs.og.current, og.focusKeywords, 'all')
        if (h) chartHandles.current.push(h)
      }
    }).catch(err => {
      console.error('[boss-view] Chart.js load failed:', err)
      setError(`Chart.js load failed: ${err.message}`)
    })
    return () => { canceled = true }
  }, [payload])     // eslint-disable-line react-hooks/exhaustive-deps

  function copySlackPreview() {
    if (!payload) return
    const text = buildSlackPostPreview(payload)
    navigator.clipboard.writeText(text).then(() => {
      setCopyOk(true)
      setTimeout(() => setCopyOk(false), 2000)
    })
  }

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
          {/* ── KPI Strip ── */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {payload.brands.flatMap(b => (['us', 'id'] as const).map(m => {
              // Sprint #371 — defensive against old cache rows that lack
              // traffic/revenue per-market shape. Empty slice → renders 0s.
              const empty: BossViewMarketSlice = { thisWeek: 0, lastWeek: 0, pct: null }
              const t = b.traffic?.[m] ?? empty
              const r = b.revenue?.[m] ?? empty
              const tp = fmtPct(t.pct)
              const rp = fmtPct(r.pct)
              return (
                <div key={`${b.siteSlug}-${m}`} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider font-semibold">{b.siteName}-{m.toUpperCase()}</p>
                  <p className="text-white font-mono text-xl mt-2">{fmtNum(t.thisWeek)}</p>
                  <p className="text-xs"><span style={{ color: tp.color }}>{tp.emoji} {tp.text} WoW</span></p>
                  <p className="text-emerald-300 font-mono text-base mt-2">{fmtUsd(r.thisWeek)}</p>
                  <p className="text-xs"><span style={{ color: rp.color }}>{rp.emoji} {rp.text} WoW</span></p>
                </div>
              )
            }))}
          </section>

          {/* ── Historical timelines: 2×2 grid ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-white mb-1">📊 Historical Trend — Last 13 Weeks</h2>
            <p className="text-xs text-gray-500 mb-4">
              Weekly organic clicks (bars, left axis) + organic revenue (line, right axis).
              Quarter back through current week. One chart per brand-country.
              <span className="text-gray-700"> (Hobby tier 60s cap — full YTD requires endpoint split, queued as Sprint #368.)</span>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { key: 'g2gUs', label: 'G2G-US', ref: histRefs.g2gUs },
                { key: 'g2gId', label: 'G2G-ID', ref: histRefs.g2gId },
                { key: 'ogUs',  label: 'OffGamers-US', ref: histRefs.ogUs },
                { key: 'ogId',  label: 'OffGamers-ID', ref: histRefs.ogId },
              ].map(c => (
                <div key={c.key} className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                  <p className="text-xs font-semibold text-gray-300 mb-2">{c.label}</p>
                  <div className="h-56">
                    <canvas ref={c.ref} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* ── Per-brand focus KW ── */}
          {payload.brands.find(b => b.siteSlug === 'g2g') && (() => {
            const brand = payload.brands.find(b => b.siteSlug === 'g2g')!
            return (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
                <h2 className="text-sm font-semibold text-white mb-1">🎯 G2G — Top 5 Focus Keywords (split per market)</h2>
                <p className="text-xs text-gray-500 mb-4">
                  Selected by composite z-score (organic clicks + winner-take-all LP revenue) over cluster_winners,
                  scoped to the named market. Min {10} clicks/week threshold.
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* US */}
                  <div>
                    <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">US Market</p>
                    {!brand.focusKeywordsUs || brand.focusKeywordsUs.length === 0 ? (
                      <p className="text-gray-500 text-sm py-4 text-center">No KWs cleared threshold</p>
                    ) : (
                      <>
                        <div className="h-64 mb-3">
                          <canvas ref={scatterRefs.g2gUs} />
                        </div>
                        <FocusTable kws={brand.focusKeywordsUs} showUs showId={false} />
                      </>
                    )}
                  </div>
                  {/* ID */}
                  <div>
                    <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">ID Market</p>
                    {!brand.focusKeywordsId || brand.focusKeywordsId.length === 0 ? (
                      <p className="text-gray-500 text-sm py-4 text-center">No KWs cleared threshold</p>
                    ) : (
                      <>
                        <div className="h-64 mb-3">
                          <canvas ref={scatterRefs.g2gId} />
                        </div>
                        <FocusTable kws={brand.focusKeywordsId} showUs={false} showId />
                      </>
                    )}
                  </div>
                </div>
                <p className="text-[10px] text-gray-700 mt-3">
                  Diagnostics: {brand.diagnostics.cluster_winner_count} cluster_winners ·
                  {' '}{brand.diagnostics.gsc_queries_fetched} GSC query rows ·
                  {' '}{brand.diagnostics.kw_with_ga4_match} KWs with GA4 LP revenue match
                </p>
              </section>
            )
          })()}

          {payload.brands.find(b => b.siteSlug === 'offgamers') && (() => {
            const brand = payload.brands.find(b => b.siteSlug === 'offgamers')!
            return (
              <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
                <h2 className="text-sm font-semibold text-white mb-1">🎯 OffGamers — Top 5 Focus Keywords (US + ID combined)</h2>
                <p className="text-xs text-gray-500 mb-4">
                  Unified list (smaller portfolio than G2G — single list keeps it readable).
                  Same selection logic: composite z-score, winner-take-all LP revenue.
                </p>
                {!brand.focusKeywords || brand.focusKeywords.length === 0 ? (
                  <p className="text-gray-500 text-sm py-6 text-center">
                    {brand.diagnostics.skip_reason ?? 'No focus keywords this week'}
                  </p>
                ) : (
                  <>
                    <div className="h-72 mb-4">
                      <canvas ref={scatterRefs.og} />
                    </div>
                    <FocusTable kws={brand.focusKeywords} showUs showId />
                  </>
                )}
                <p className="text-[10px] text-gray-700 mt-3">
                  Diagnostics: {brand.diagnostics.cluster_winner_count} cluster_winners ·
                  {' '}{brand.diagnostics.gsc_queries_fetched} GSC query rows ·
                  {' '}{brand.diagnostics.kw_with_ga4_match} KWs with GA4 LP revenue match
                </p>
              </section>
            )
          })()}

          {/* ── AI source ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <h2 className="text-sm font-semibold text-white mb-1">🤖 AI Source — ChatGPT · Perplexity · Gemini · Claude · Copilot</h2>
            <p className="text-xs text-gray-500 mb-3">
              GA4 sessions where the source domain is an AI assistant. Filtered server-side
              regardless of whether the &quot;AI Source&quot; channel group is deployed.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {payload.brands.map(brand => {
                const slice = payload.aiSource.bySite[brand.siteSlug]
                if (!slice || slice.skipReason) {
                  return (
                    <div key={brand.siteSlug} className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-xs text-gray-500">
                      <p className="font-semibold text-gray-400 mb-1">{brand.siteName}</p>
                      <p>⚠ {slice?.skipReason ?? 'no AI source data'}</p>
                    </div>
                  )
                }
                const usersPct   = fmtPct(slice.prevTotalUsers > 0 ? Math.round(((slice.totalUsers - slice.prevTotalUsers) / slice.prevTotalUsers) * 1000) / 10 : null)
                const revenuePct = fmtPct(slice.prevTotalRevenue > 0 ? Math.round(((slice.totalRevenue - slice.prevTotalRevenue) / slice.prevTotalRevenue) * 1000) / 10 : null)
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

          {/* ── Slack post preview ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">📋 Slack Post Preview</h2>
              <button
                onClick={copySlackPreview}
                className="text-xs bg-purple-700 hover:bg-purple-600 text-white px-3 py-1.5 rounded transition"
              >
                {copyOk ? '✅ Copied!' : '📋 Copy to clipboard'}
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Exact text that would post to the Slack channel. Charts referenced will be
              attached as PNG (todo in next sprint).
            </p>
            <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-[11px] text-gray-300 font-mono whitespace-pre overflow-x-auto leading-tight">{buildSlackPostPreview(payload)}</pre>
          </section>

          <p className="text-[10px] text-gray-600 text-center pb-4">
            Cur window: {payload.curStart} → {payload.curEnd} ·
            Prev window: {payload.prevStart} → {payload.prevEnd}
          </p>
        </>
      )}
    </div>
  )
}

// ─── FocusTable sub-component ──────────────────────────────────────────────

interface FocusTableProps {
  kws:    FocusKeyword[]
  showUs: boolean
  showId: boolean
}

function FocusTable({ kws, showUs, showId }: FocusTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 uppercase tracking-wider text-[10px]">
            <th className="text-left py-1.5 pr-3">Keyword</th>
            <th className="text-right pr-3">Clicks</th>
            <th className="text-right pr-3">Revenue</th>
            {showUs && <th className="text-right pr-3">US Rank</th>}
            {showId && <th className="text-right pr-3">ID Rank</th>}
            <th className="text-right">Score</th>
          </tr>
        </thead>
        <tbody>
          {kws.map(k => {
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
                {showUs && (
                  <td className="text-right pr-3 font-mono">
                    <span style={{ color: usLight.color }}>
                      {k.us.thisWeek != null ? `#${k.us.thisWeek}` : '—'}
                      <span className="text-gray-500 ml-1">{rankArrow(k.us.lastWeek, k.us.thisWeek)}</span>
                    </span>
                  </td>
                )}
                {showId && (
                  <td className="text-right pr-3 font-mono">
                    <span style={{ color: idLight.color }}>
                      {k.id.thisWeek != null ? `#${k.id.thisWeek}` : '—'}
                      <span className="text-gray-500 ml-1">{rankArrow(k.id.lastWeek, k.id.thisWeek)}</span>
                    </span>
                  </td>
                )}
                <td className="text-right text-gray-500 font-mono">{k.score.toFixed(2)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
