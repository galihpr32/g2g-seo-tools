'use client'

/**
 * Sprint #373 — Shared Boss View content component.
 *
 * Extracted from src/app/(dashboard)/reports/friday-kpi/boss-view/page.tsx
 * so both the admin dashboard page and the public /reports/[slug] page can
 * render the same chart/table/preview content from a payload, without each
 * page needing to duplicate ~900 lines.
 *
 * Consumer pages handle their own:
 *   - data fetching (GET cached / POST refresh / GET public snapshot)
 *   - <header> (different titles + buttons for admin vs public)
 *
 * This component handles everything else: KPI strip, historical charts,
 * focus-keyword tables + scatter charts, AI source panel, Slack preview.
 *
 * Defensive behavior carried over from earlier sprints:
 *   - Sprint #371/372: brand.traffic?.[m] / brand.revenue?.[m] guards for
 *     old cached payloads that lack the per-market shape.
 *   - Sprint #367: histOrEmpty() in chart-render useEffect so old cached
 *     payloads without `historical` still render (empty buckets).
 */

import { useEffect, useRef, useState } from 'react'

// ─── Types (mirror boss-view.ts) ────────────────────────────────────────────

export interface BossViewMarketSlice {
  thisWeek: number
  lastWeek: number
  pct:      number | null
}

export interface HistoricalBucket {
  weekEnd: string
  clicks:  number
  revenue: number
}

export interface FocusKeyword {
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

export interface BossViewBrand {
  siteSlug: string
  siteName: string
  traffic:  { us: BossViewMarketSlice; id: BossViewMarketSlice }
  revenue:  { us: BossViewMarketSlice; id: BossViewMarketSlice }
  historical: { us: HistoricalBucket[]; id: HistoricalBucket[] }
  // Sprint #397 — set when GSC clicks landed but GA4 revenue is still
  // aggregating (24-48h lag). UI shows a banner instead of misleading $0.
  revenuePending?: { us: boolean; id: boolean }
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

export interface AiSource {
  domain:       string
  label:        string
  users:        number
  sessions:     number
  revenue:      number
  prevUsers:    number
  prevSessions: number
  prevRevenue:  number
}

export interface AiSiteSlice {
  sources:           AiSource[]
  totalUsers:        number
  totalSessions:     number
  totalRevenue:      number
  prevTotalUsers:    number
  prevTotalSessions: number
  prevTotalRevenue:  number
  skipReason?:       string
}

export interface Payload {
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

function buildSlackPostPreview(payload: Payload, commentary?: BossViewCommentary | null): string {
  const lines: string[] = []
  const sep = '━'.repeat(60)
  const weekRange = `${shortWeekLabel(payload.curStart)}–${shortWeekLabel(payload.curEnd)}`

  lines.push(sep)
  lines.push(`📸  Weekly Snapshot  |  ${payload.weekLabel.split('·')[0].trim()}  ·  ${weekRange}`)
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
  if (commentary?.whyWorked || commentary?.actionTaken) {
    if (commentary.whyWorked)   lines.push(`  ✅ Why it worked:  ${commentary.whyWorked}`)
    if (commentary.actionTaken) lines.push(`  🔧 Action taken:   ${commentary.actionTaken}`)
  } else {
    lines.push('  ✅ Why it worked:  [Generate via dashboard]')
    lines.push('  🔧 Action taken:   [Generate via dashboard]')
  }
  lines.push(sep)
  return lines.join('\n')
}

// ─── Component ──────────────────────────────────────────────────────────────

// Sprint #374 — commentary block. Sourced from the cache row's `commentary`
// column on admin pages; from `payload.commentary` (server-injected) on
// public pages.
export interface BossViewCommentary {
  whyWorked:     string
  actionTaken:   string
  autoGenerated: boolean
  generatedAt:   string
  model?:        string
}

export interface BossViewContentProps {
  payload: Payload | null
  loading?: boolean
  error?: string | null
  /** Sprint #374 — commentary state. When `commentary` is set, the
   *  commentary cards render. When `onSaveCommentary`/`onRegenerate` are
   *  provided, the cards become editable (admin mode). Public mode = pass
   *  commentary but omit the handlers. */
  commentary?:        BossViewCommentary | null
  onSaveCommentary?:  (next: { whyWorked: string; actionTaken: string }) => Promise<void>
  onRegenerateCommentary?: () => Promise<void>
  commentaryBusy?:    boolean
  /** Sprint #380 — when set, the Download PDF button hits the public PDF
   *  endpoint scoped to this slug (`?slug=…`). When undefined, the button
   *  calls the auth-gated endpoint that reads the caller's cached payload
   *  (admin preview mode). */
  publicSlug?:        string
}

export function BossViewContent({
  payload, loading, error,
  commentary, onSaveCommentary, onRegenerateCommentary, commentaryBusy,
  publicSlug,
}: BossViewContentProps) {
  const [copyOk, setCopyOk] = useState(false)
  // Sprint #374 — local edit buffer. To avoid the React-19
  // `react-hooks/set-state-in-effect` lint error (and the cascading-render
  // smell), we NEVER sync draft<-commentary via useEffect. Instead:
  //   - When NOT editing → display the live commentary value directly
  //   - When user clicks Edit → seed the draft from the current commentary
  //     value (snapshot at that moment) and flip `editing` on
  //   - On Save → call handler with draft; parent updates commentary; we
  //     flip `editing` off (rendering reverts to live commentary value)
  //   - On Cancel → just flip `editing` off (drafts are discarded next time
  //     Edit is clicked since `startEditing` re-seeds them)
  const [editing, setEditing] = useState(false)
  const [draftWhy,    setDraftWhy]    = useState('')
  const [draftAction, setDraftAction] = useState('')
  function startEditing() {
    setDraftWhy(commentary?.whyWorked ?? '')
    setDraftAction(commentary?.actionTaken ?? '')
    setEditing(true)
  }
  const isEditable = typeof onSaveCommentary === 'function'

  // 4 historical chart canvases (one per brand-country)
  const histG2gUs = useRef<HTMLCanvasElement>(null)
  const histG2gId = useRef<HTMLCanvasElement>(null)
  const histOgUs  = useRef<HTMLCanvasElement>(null)
  const histOgId  = useRef<HTMLCanvasElement>(null)
  // 3 scatter charts
  const scatterG2gUs = useRef<HTMLCanvasElement>(null)
  const scatterG2gId = useRef<HTMLCanvasElement>(null)
  const scatterOg    = useRef<HTMLCanvasElement>(null)
  const chartHandles = useRef<ChartHandle[]>([])
  const [chartErr, setChartErr] = useState<string | null>(null)

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
      if (histG2gUs.current && g2g) {
        const h = makeHistoricalChart(histG2gUs.current, histOrEmpty(g2g).us, 'g2g-us')
        if (h) chartHandles.current.push(h)
      }
      if (histG2gId.current && g2g) {
        const h = makeHistoricalChart(histG2gId.current, histOrEmpty(g2g).id, 'g2g-id')
        if (h) chartHandles.current.push(h)
      }
      if (histOgUs.current && og) {
        const h = makeHistoricalChart(histOgUs.current, histOrEmpty(og).us, 'offgamers-us')
        if (h) chartHandles.current.push(h)
      }
      if (histOgId.current && og) {
        const h = makeHistoricalChart(histOgId.current, histOrEmpty(og).id, 'offgamers-id')
        if (h) chartHandles.current.push(h)
      }

      // Scatter charts
      if (scatterG2gUs.current && g2g?.focusKeywordsUs) {
        const h = makeScatter(scatterG2gUs.current, g2g.focusKeywordsUs, 'us')
        if (h) chartHandles.current.push(h)
      }
      if (scatterG2gId.current && g2g?.focusKeywordsId) {
        const h = makeScatter(scatterG2gId.current, g2g.focusKeywordsId, 'id')
        if (h) chartHandles.current.push(h)
      }
      if (scatterOg.current && og?.focusKeywords) {
        const h = makeScatter(scatterOg.current, og.focusKeywords, 'all')
        if (h) chartHandles.current.push(h)
      }
    }).catch((err: Error) => {
      console.error('[boss-view] Chart.js load failed:', err)
      setChartErr(`Chart.js load failed: ${err.message}`)
    })
    return () => { canceled = true }
  }, [payload])

  function copySlackPreview() {
    if (!payload) return
    const text = buildSlackPostPreview(payload, commentary)
    navigator.clipboard.writeText(text).then(() => {
      setCopyOk(true)
      setTimeout(() => setCopyOk(false), 2000)
    })
  }

  async function saveEdits() {
    if (!onSaveCommentary) return
    await onSaveCommentary({ whyWorked: draftWhy.trim(), actionTaken: draftAction.trim() })
    setEditing(false)
  }

  // Sprint #380 — server-side Puppeteer PDF export. Replaces the old
  // window.print() approach (Chrome's print dialog produced an ugly PDF
  // with the URL footer + date header artifacts that the social team
  // wouldn't want to share). The endpoint runs a headless Chromium server-
  // side, renders our branded HTML template, and streams back a clean PDF.
  //
  // Two modes:
  //   - publicSlug set (public /reports/[slug] page) → hit /pdf?slug=…
  //   - publicSlug undefined (admin dashboard) → hit /pdf (auth-gated cache)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfErr,  setPdfErr]  = useState<string | null>(null)
  async function downloadPdf() {
    if (pdfBusy) return
    setPdfBusy(true)
    setPdfErr(null)
    try {
      const url = publicSlug
        ? `/api/reports/friday-kpi/boss-view/pdf?slug=${encodeURIComponent(publicSlug)}`
        : '/api/reports/friday-kpi/boss-view/pdf'
      const res = await fetch(url, { method: 'GET' })
      if (!res.ok) {
        // Try to parse a JSON error body — the route returns
        // { error: string } on the failure paths.
        const ct = res.headers.get('content-type') ?? ''
        if (ct.includes('application/json')) {
          const data = await res.json().catch(() => ({})) as { error?: string }
          throw new Error(data.error ?? `HTTP ${res.status}`)
        }
        throw new Error(`HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const blobUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = blobUrl
      a.download = `weekly-snapshot-${publicSlug ?? 'preview'}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Give the browser a beat to actually start the download before
      // revoking the URL (Chrome can race the revoke otherwise).
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'PDF download failed'
      setPdfErr(msg)
    } finally {
      setPdfBusy(false)
    }
  }

  return (
    <>
      {/* Sprint #379 — print stylesheet. Hides sidebar/buttons/dismissibles
          and tightens spacing so browser "Save as PDF" produces a clean
          multi-page document. Charts (Chart.js canvas) print as-is. Each
          major section gets a page-break-inside:avoid to keep cards intact. */}
      <style jsx global>{`
        @media print {
          aside, nav, button { display: none !important; }
          /* Hide the dashboard sidebar layout chrome */
          .sidebar, [class*="Sidebar"] { display: none !important; }
          body { background: #ffffff !important; color: #0F1218 !important; }
          /* Force dark cards to white background + dark text for PDF */
          .bg-gray-900, .bg-gray-950, .bg-black { background: #ffffff !important; }
          .text-white, .text-gray-200, .text-gray-300, .text-gray-400 { color: #0F1218 !important; }
          .border-gray-800, .border-gray-700, .border-gray-800\\/60 {
            border-color: #d1d5db !important;
          }
          section { page-break-inside: avoid; margin-bottom: 12pt !important; }
          h1, h2, h3 { color: #0F1218 !important; }
          /* Make sure charts render at full size, not collapsed */
          canvas { max-height: 380px !important; }
          /* Hide commentary edit controls + buttons */
          .print-hide { display: none !important; }
        }
      `}</style>

      {(error || chartErr || pdfErr) && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-700/40 text-red-300 text-sm rounded-lg print-hide">
          {error || chartErr || pdfErr}
        </div>
      )}

      {loading && !payload && (
        <div className="flex justify-center py-16 text-gray-500">Loading boss view…</div>
      )}

      {payload && (
        <>
          {/* Sprint #379 — Download PDF button. Floats at top-right of content;
              hidden in print output via .print-hide. */}
          <div className="flex justify-end mb-3 print-hide">
            <button
              onClick={downloadPdf}
              disabled={pdfBusy}
              className="text-xs bg-indigo-700 hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-lg transition font-medium"
              title="Generate a branded, server-side PDF (10–30s)"
            >{pdfBusy ? '⏳ Generating PDF…' : '📄 Download PDF'}</button>
          </div>
          {/* Sprint #397 — GA4 freshness banner. Shows when ANY brand-market
              has GSC clicks for the current week but GA4 revenue is still 0
              (typical 24-48h aggregation lag). Actionable guidance below
              tells the viewer exactly what to do. */}
          {(() => {
            const pendingMarkets: string[] = []
            for (const b of payload.brands) {
              if (b.revenuePending?.us) pendingMarkets.push(`${b.siteName}-US`)
              if (b.revenuePending?.id) pendingMarkets.push(`${b.siteName}-ID`)
            }
            if (pendingMarkets.length === 0) return null
            return (
              <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 text-sm">
                <p className="text-amber-300 font-semibold mb-1">⏳ GA4 revenue still aggregating</p>
                <p className="text-amber-200/80 leading-relaxed">
                  Clicks landed but revenue events haven&apos;t finished aggregating for{' '}
                  <span className="font-mono">{pendingMarkets.join(', ')}</span>.
                  GA4 typically needs 24–48h post-week to finalize purchase data.
                </p>
                <p className="text-amber-200/70 leading-relaxed mt-2 text-xs">
                  <span className="font-semibold">What to do:</span> wait until tomorrow same hour, then click
                  <span className="text-amber-100"> 🔄 Refresh data</span>. Verify by opening{' '}
                  <a className="underline hover:text-amber-100" href="https://analytics.google.com" target="_blank" rel="noreferrer">GA4 dashboard</a>
                  {' '}→ Reports → Traffic acquisition → Country filter to your market → check the date range matches the snapshot window.
                </p>
              </div>
            )
          })()}

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
              // Sprint #397 — flag this card if GA4 revenue hasn't aggregated yet.
              const pending = b.revenuePending?.[m] === true
              return (
                <div key={`${b.siteSlug}-${m}`} className={`bg-gray-900 border rounded-xl p-4 ${pending ? 'border-amber-500/40' : 'border-gray-800'}`}>
                  <p className="text-gray-500 text-[10px] uppercase tracking-wider font-semibold">{b.siteName}-{m.toUpperCase()}</p>
                  <p className="text-white font-mono text-xl mt-2">{fmtNum(t.thisWeek)}</p>
                  <p className="text-xs"><span style={{ color: tp.color }}>{tp.emoji} {tp.text} WoW</span></p>
                  {pending ? (
                    <>
                      <p className="text-amber-300 font-mono text-base mt-2">⏳ pending</p>
                      <p className="text-xs text-amber-200/70">GA4 still aggregating</p>
                    </>
                  ) : (
                    <>
                      <p className="text-emerald-300 font-mono text-base mt-2">{fmtUsd(r.thisWeek)}</p>
                      <p className="text-xs"><span style={{ color: rp.color }}>{rp.emoji} {rp.text} WoW</span></p>
                    </>
                  )}
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
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs font-semibold text-gray-300 mb-2">G2G-US</p>
                <div className="h-56">
                  <canvas ref={histG2gUs} />
                </div>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs font-semibold text-gray-300 mb-2">G2G-ID</p>
                <div className="h-56">
                  <canvas ref={histG2gId} />
                </div>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs font-semibold text-gray-300 mb-2">OffGamers-US</p>
                <div className="h-56">
                  <canvas ref={histOgUs} />
                </div>
              </div>
              <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
                <p className="text-xs font-semibold text-gray-300 mb-2">OffGamers-ID</p>
                <div className="h-56">
                  <canvas ref={histOgId} />
                </div>
              </div>
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
                          <canvas ref={scatterG2gUs} />
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
                          <canvas ref={scatterG2gId} />
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
                      <canvas ref={scatterOg} />
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

          {/* ── Commentary (Sprint #374) ── */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                📝 Commentary
                {commentary?.autoGenerated && (
                  <span className="text-[10px] px-2 py-0.5 bg-purple-700/30 text-purple-300 rounded font-normal">AI-suggested</span>
                )}
                {commentary && !commentary.autoGenerated && (
                  <span className="text-[10px] px-2 py-0.5 bg-emerald-700/30 text-emerald-300 rounded font-normal">Edited</span>
                )}
              </h2>
              {isEditable && (
                <div className="flex gap-2">
                  {editing ? (
                    <>
                      <button
                        onClick={() => setEditing(false)}
                        className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition"
                      >Cancel</button>
                      <button
                        onClick={saveEdits}
                        disabled={commentaryBusy}
                        className="text-xs bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white px-3 py-1.5 rounded transition"
                      >💾 Save</button>
                    </>
                  ) : (
                    <>
                      {commentary && (
                        <button
                          onClick={startEditing}
                          className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition"
                        >✏ Edit</button>
                      )}
                      <button
                        onClick={() => onRegenerateCommentary?.()}
                        disabled={commentaryBusy}
                        className="text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white px-3 py-1.5 rounded transition"
                      >{commentaryBusy ? '⏳ Generating…' : (commentary ? '🔄 Regenerate' : '✨ Generate via AI')}</button>
                    </>
                  )}
                </div>
              )}
            </div>
            <p className="text-xs text-gray-500 mb-3">
              Two-line exec narrative auto-flows into the Slack post + published page.
              {isEditable && ' Click ✏ Edit to override the AI suggestion before sharing.'}
            </p>
            {commentary || editing ? (
              <div className="space-y-3">
                <div className="bg-gray-950 border-l-4 border-emerald-600 p-3 rounded">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-400 font-semibold mb-1">✅ Why it worked</p>
                  {editing ? (
                    <textarea
                      value={draftWhy}
                      onChange={e => setDraftWhy(e.target.value)}
                      maxLength={300}
                      rows={2}
                      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded p-2 focus:outline-none focus:border-emerald-500"
                      placeholder="What drove this week's biggest win — be specific (numbers, brand-country, KW)."
                    />
                  ) : (
                    <p className="text-sm text-gray-200">{commentary?.whyWorked || <span className="text-gray-600 italic">(empty)</span>}</p>
                  )}
                </div>
                <div className="bg-gray-950 border-l-4 border-amber-600 p-3 rounded">
                  <p className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold mb-1">🔧 Action taken / next</p>
                  {editing ? (
                    <textarea
                      value={draftAction}
                      onChange={e => setDraftAction(e.target.value)}
                      maxLength={300}
                      rows={2}
                      className="w-full bg-gray-900 border border-gray-700 text-gray-200 text-sm rounded p-2 focus:outline-none focus:border-amber-500"
                      placeholder="Biggest concern + what to do about it next week."
                    />
                  ) : (
                    <p className="text-sm text-gray-200">{commentary?.actionTaken || <span className="text-gray-600 italic">(empty)</span>}</p>
                  )}
                </div>
                {commentary?.generatedAt && !editing && (
                  <p className="text-[10px] text-gray-600">
                    {commentary.autoGenerated ? 'Generated' : 'Last edited'} {new Date(commentary.generatedAt).toLocaleString()}
                    {commentary.model && commentary.autoGenerated && ` · ${commentary.model}`}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-500 italic py-3">
                No commentary yet. {isEditable ? 'Click "✨ Generate via AI" above to draft a default.' : 'Admin hasn\'t generated commentary for this snapshot.'}
              </p>
            )}
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
              Exact text that would post to the Slack channel. Commentary block auto-flows in.
              Charts referenced will be attached as PNG (todo in next sprint).
            </p>
            <pre className="bg-gray-950 border border-gray-800 rounded-lg p-4 text-[11px] text-gray-300 font-mono whitespace-pre overflow-x-auto leading-tight">{buildSlackPostPreview(payload, commentary)}</pre>
          </section>

          <p className="text-[10px] text-gray-600 text-center pb-4">
            Cur window: {payload.curStart} → {payload.curEnd} ·
            Prev window: {payload.prevStart} → {payload.prevEnd}
          </p>
        </>
      )}
    </>
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
