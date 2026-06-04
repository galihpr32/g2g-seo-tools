'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'
import AgentActivitySummary, { type AgentInsightsLite } from '@/components/reports/AgentActivitySummary'
import MimirPanel from '@/components/agents/MimirPanel'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GscData {
  monthClicks: number
  prevMonthClicks: number
  clicksPct: number | null
  monthImpressions: number
  prevImpressions: number
  impressionsPct: number | null
  monthCtr: number
  prevCtr: number
  ctrPct: number | null
  avgPosition: number
  totalUniquePages: number
  topGainers: { page: string; delta: number; clicks: number }[]
  topDroppers: { page: string; delta: number; clicks: number }[]
  topPagesByClicks: { page: string; clicks: number; impressions: number }[]
}

interface Ga4Data {
  monthSessions: number
  prevSessions: number
  sessionsPct: number | null
  engagedSessions: number
  bounceRate: number
  totalConversions: number
  prevConversions: number
  conversionsPct: number | null
  totalRevenue: number
  prevRevenue: number
  revenuePct: number | null
  topPages: { pagePath: string; sessions: number; conversions: number; revenue: number; prevSessions?: number; sessionsPct?: number | null }[]
}

// ── v2 — Channel Breakdown (GA4 sessionDefaultChannelGroup) ─────────────────
interface ChannelBreakdown {
  rows: {
    channel:        string
    sessions:       number
    prevSessions:   number
    sessionsPct:    number | null
    conversions:    number
    prevConversions: number
    conversionsPct: number | null
    revenue:        number
    prevRevenue:    number
    revenuePct:     number | null
    share:          number
  }[]
  totalCur:  { sessions: number; conversions: number; revenue: number }
  totalPrev: { sessions: number; conversions: number; revenue: number }
}

// ── v2 — Tracked-product ranking analysis ──────────────────────────────────
interface RankingMovement {
  keyword:       string
  productName:   string
  productPath:   string
  curPosition:   number | null
  prevPosition:  number | null
  movement:      number | null
  bestPosition:  number | null
  searchVolume:  number | null
  url:           string | null
}
interface RankingBuckets { top3: number; top5: number; top10: number; top20: number; top100: number; total: number; ranked: number }
interface RankingActionItem {
  keyword:        string
  productName:    string
  curPosition:    number | null
  movement:       number | null
  recommendation: string
  priority:       'P0' | 'P1' | 'P2'
  category:       string
}
interface TrackedRankings {
  bucketsCur:   RankingBuckets
  bucketsPrev:  RankingBuckets
  movements:    RankingMovement[]
  topImprovers: RankingMovement[]
  topDroppers:  RankingMovement[]
  actionPlan:   RankingActionItem[] | null
}

// ── v2 — Experiments snapshot ──────────────────────────────────────────────
interface ExperimentBrief {
  id: string
  title: string
  hypothesis: string | null
  category: string | null
  success_metric: string | null
  source: string | null
  current_value?: number | null
  target_value?: number | null
  outcome?: string | null
  decision_notes?: string | null
}
interface ExperimentsSnapshot {
  period: string
  start: ExperimentBrief[]
  continue: ExperimentBrief[]
  stop: ExperimentBrief[]
}

interface SemrushData {
  totalKeywords: number
  top3: number
  top10: number
  top20: number
  avgPosition: number
  organicTraffic: number
  topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]
  topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[]
}

interface ActionItemsData {
  total: number
  pending: number
  inProgress: number
  done: number
}

interface BacklinkItem {
  siteName: string
  externalUrl: string
  anchorText: string
  targetPage: string
  targetKeyword: string | null
  liveDate: string | null
  costAmount: number | null
  costCurrency: string | null
  positionCurrent: number | null
  positionAtCreation: number | null
}

interface BacklinksData {
  totalActive: number
  newThisMonth: number
  pendingLinks: number
  brokenLinks: number
  totalCostThisMonth: number      // USD only (legacy)
  totalCostAllTime: number         // USD only (legacy)
  costsByCurrency?: { currency: string; total: number }[]
  allTimeCostsByCurrency?: { currency: string; total: number }[]
  avgPositionImprovement: number | null
  recentLinks: BacklinkItem[]
}

interface SovRow { domain: string; sov: number; keywords: number }

interface ReportData {
  monthStart: string
  monthEnd: string
  monthLabel: string
  prevMonthLabel: string
  gsc: GscData
  ga4: Ga4Data | null
  semrush: SemrushData
  actionItems: ActionItemsData
  backlinks?: BacklinksData   // optional for old reports
  competitive: {
    trackedCompetitors: { domain: string; name?: string }[]
    sovTable:      SovRow[]
    sovEstimated?: boolean
  }
  // Agent activity (v3+) — null for old reports
  agentInsights?: AgentInsightsLite | null

  // v2 — added 2026-05. All optional so older reports still render.
  channelBreakdown?: ChannelBreakdown | null
  trackedRankings?: TrackedRankings  | null
  experiments?:     ExperimentsSnapshot | null
}

interface MonthlyReport {
  id: string
  month_start: string
  month_end: string
  created_at: string
  report_data: ReportData
  ai_narrative: string
  ai_action_plan: string
}

interface ReportSummary {
  id: string
  month_start: string
  month_end: string
  created_at: string
  ai_narrative: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString() }

function fmtUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}K`
  return `$${Math.round(n).toLocaleString()}`
}

// Currency-aware cost formatter — handles IDR, USD, and others
function fmtCost(amount: number, currency?: string | null): string {
  const c = (currency ?? 'USD').toUpperCase()
  if (c === 'IDR') {
    if (amount >= 1_000_000_000) return `Rp ${(amount / 1_000_000_000).toFixed(1)}B`
    if (amount >= 1_000_000)     return `Rp ${(amount / 1_000_000).toFixed(1)}M`
    if (amount >= 1_000)         return `Rp ${(amount / 1_000).toFixed(0)}K`
    return `Rp ${Math.round(amount).toLocaleString()}`
  }
  return fmtUsd(amount)
}

// Format a costsByCurrency array into a short display string e.g. "$5K · Rp 2M"
function fmtCostByCurrency(costs?: { currency: string; total: number }[]): string {
  if (!costs?.length) return '—'
  return costs
    .filter(c => c.total > 0)
    .map(c => fmtCost(c.total, c.currency))
    .join(' · ') || '—'
}

function pctBadge(pct: number | null | undefined) {
  if (pct == null) return null
  const up = pct >= 0
  return (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${up ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
      {up ? '↑' : '↓'}{Math.abs(pct)}%
    </span>
  )
}

function fmtUrl(url: string) {
  return url.replace('https://www.g2g.com', '').replace('https://g2g.com', '') || '/'
}

function getDefaultMonth(): { year: number; month: number } {
  const now = new Date()
  const m = now.getMonth() === 0 ? 12 : now.getMonth()
  const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
  return { year: y, month: m }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, pct, sub }: { icon: string; label: string; value: string; pct?: number | null; sub?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">{label}</span>
        <span className="text-base">{icon}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-white">{value}</span>
        {pct != null && pctBadge(pct)}
      </div>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function QuickSummary({ d }: { d: ReportData; report?: MonthlyReport }) {
  const points: { icon: string; label: string; value: string; delta?: string; deltaUp?: boolean }[] = []

  // GSC
  points.push({
    icon: '🖱️',
    label: 'Clicks',
    value: d.gsc.monthClicks.toLocaleString(),
    delta: d.gsc.clicksPct != null ? `${d.gsc.clicksPct > 0 ? '+' : ''}${d.gsc.clicksPct}% vs prev month` : undefined,
    deltaUp: (d.gsc.clicksPct ?? 0) >= 0,
  })
  points.push({
    icon: '👁️',
    label: 'Impressions',
    value: d.gsc.monthImpressions.toLocaleString(),
    delta: d.gsc.impressionsPct != null ? `${d.gsc.impressionsPct > 0 ? '+' : ''}${d.gsc.impressionsPct}%` : undefined,
    deltaUp: (d.gsc.impressionsPct ?? 0) >= 0,
  })
  points.push({ icon: '📍', label: 'Avg. Position', value: String(d.gsc.avgPosition) })
  points.push({
    icon: '🎯',
    label: 'Keyword Coverage',
    value: `${d.semrush.top3} in Top 3 · ${d.semrush.top10} in Top 10 · ${d.semrush.top20} in Top 20`,
  })
  if (d.ga4) {
    points.push({
      icon: '📈',
      label: 'Organic Sessions',
      value: d.ga4.monthSessions.toLocaleString(),
      delta: d.ga4.sessionsPct != null ? `${d.ga4.sessionsPct > 0 ? '+' : ''}${d.ga4.sessionsPct}%` : undefined,
      deltaUp: (d.ga4.sessionsPct ?? 0) >= 0,
    })
    if (d.ga4.totalRevenue > 0) {
      points.push({
        icon: '💰',
        label: 'Revenue',
        value: fmtUsd(d.ga4.totalRevenue),
        delta: d.ga4.revenuePct != null ? `${d.ga4.revenuePct > 0 ? '+' : ''}${d.ga4.revenuePct}%` : undefined,
        deltaUp: (d.ga4.revenuePct ?? 0) >= 0,
      })
    }
  }
  if (d.backlinks) {
    const costStr = fmtCostByCurrency(d.backlinks.costsByCurrency)
    points.push({
      icon: '🔗',
      label: 'Paid Backlinks',
      value: `${d.backlinks.newThisMonth} new · ${d.backlinks.totalActive} active`,
      delta: costStr !== '—' ? `cost: ${costStr}` : undefined,
    })
  }
  points.push({
    icon: '✅',
    label: 'Action Items',
    value: `${d.actionItems.done} done · ${d.actionItems.pending + d.actionItems.inProgress} open`,
  })

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">📋</span>
        <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Quick Summary</h3>
        <span className="text-[10px] text-gray-600">{d.monthLabel}</span>
      </div>
      <ul className="divide-y divide-gray-800">
        {points.map((p, i) => (
          <li key={i} className="flex items-center justify-between py-2 gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm flex-shrink-0">{p.icon}</span>
              <span className="text-xs text-gray-400 flex-shrink-0">{p.label}</span>
            </div>
            <div className="flex items-center gap-2 text-right min-w-0">
              <span className="text-xs font-semibold text-white truncate">{p.value}</span>
              {p.delta && (
                <span className={`text-[10px] flex-shrink-0 font-medium ${p.deltaUp ? 'text-green-400' : 'text-red-400'}`}>
                  {p.delta}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ActionPlan({ raw }: { raw: string }) {
  if (!raw) return null
  const lines = raw.split('\n').filter(l => l.trim())
  return (
    <ol className="space-y-3">
      {lines.map((line, i) => {
        const match = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s*[–—-]\s*(.+)/)
        if (match) {
          return (
            <li key={i} className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-red-700 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-semibold text-white">{match[1]}</p>
                <p className="text-sm text-gray-400 mt-0.5">{match[2]}</p>
              </div>
            </li>
          )
        }
        return (
          <li key={i} className="flex gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-red-700 text-white text-xs font-bold flex items-center justify-center mt-0.5">
              {i + 1}
            </span>
            <p className="text-sm text-gray-300">{line.replace(/^\d+\.\s*/, '').replace(/\*\*/g, '')}</p>
          </li>
        )
      })}
    </ol>
  )
}

// ── v2 — Channel breakdown card ────────────────────────────────────────────
function ChannelBreakdownSection({ cb, curLabel, prevLabel }: { cb: ChannelBreakdown; curLabel: string; prevLabel: string }) {
  const rows = cb.rows.slice(0, 8)
  const maxSessions = Math.max(...rows.map(r => Math.max(r.sessions, r.prevSessions)), 1)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">📡 Traffic by Channel</h3>
        <p className="text-[10px] text-gray-500">Sessions · {fmt(cb.totalCur.sessions)} this month vs {fmt(cb.totalPrev.sessions)} last</p>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Channel</th>
            <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">{curLabel}</th>
            <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">{prevLabel}</th>
            <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-24">Δ MoM</th>
            <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-16">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const pct = r.sessionsPct
            const isBigDrop = pct != null && pct <= -20
            const isBigGain = pct != null && pct >= 20
            return (
              <tr key={r.channel} className="border-b border-gray-800/50 last:border-0">
                <td className="py-2 pr-3">
                  <div>
                    <p className="text-white font-medium">{r.channel}</p>
                    <div className="flex gap-1 mt-1 h-1">
                      <div className="bg-red-600/80 rounded-full" style={{ width: `${Math.round((r.sessions / maxSessions) * 100)}%` }} />
                    </div>
                  </div>
                </td>
                <td className="py-2 text-right text-gray-200 font-medium">{fmt(r.sessions)}</td>
                <td className="py-2 text-right text-gray-500">{fmt(r.prevSessions)}</td>
                <td className="py-2 text-right">
                  {pct == null ? (
                    <span className="text-gray-700">—</span>
                  ) : (
                    <span className={`font-semibold ${
                      isBigGain ? 'text-green-400' :
                      pct >= 0  ? 'text-green-500' :
                      isBigDrop ? 'text-red-400 font-bold' :
                                  'text-red-500'
                    }`}>
                      {pct >= 0 ? '▲' : '▼'}{Math.abs(pct)}%
                    </span>
                  )}
                </td>
                <td className="py-2 text-right text-gray-400">{r.share.toFixed(1)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── v2 — Key Takeaways card grid (mirrors PPTX slide 4) ──────────────────
//
// Galih's PPTX template uses a 2x3 grid of cards with colored top stripes:
// yellow=watch, red=decline, green=gain. Each card has an icon, a trend
// badge top-right, a bold headline, and 2-3 sentences of body.
//
// Source: split ai_narrative by paragraph and classify each via keyword
// sentiment heuristic. This is "good enough for v1" without an extra LLM
// call. When narrative_highlights JSONB is set on the report (future
// enhancement), prefer that.

interface NarrativeHighlight {
  trend:    'up' | 'down' | 'flat' | 'warning'
  headline: string
  body:     string
  icon:     string
}

const TREND_THEME: Record<NarrativeHighlight['trend'], { stripe: string; badge: string; label: string }> = {
  up:      { stripe: 'bg-green-500',  badge: 'bg-green-500/15 text-green-300 border-green-500/30',   label: 'GAIN'    },
  down:    { stripe: 'bg-red-500',    badge: 'bg-red-500/15 text-red-300 border-red-500/30',         label: 'DECLINE' },
  warning: { stripe: 'bg-amber-500',  badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',   label: 'WATCH'   },
  flat:    { stripe: 'bg-gray-500',   badge: 'bg-gray-700/40 text-gray-400 border-gray-700',          label: 'FLAT'    },
}

function classifyTrend(text: string): NarrativeHighlight['trend'] {
  const t = text.toLowerCase()
  // Strong positive signals
  if (/\b(grew|growth|gain|rose|increase|improved|exceeded|outperformed|wins?|landed)\b|\+\d|up \d+/.test(t)) return 'up'
  // Strong negative signals
  if (/\b(declined|drop|dropped|lost|fell|decrease|down \d+|missed|failed|stalled|underperformed|−\d|-\d+%)\b/.test(t)) return 'down'
  // Watch signals
  if (/\b(divergence|unreliable|broken|issue|investigate|concerning|risk|caution|monitor)\b/.test(t)) return 'warning'
  return 'flat'
}

function extractHeadline(paragraph: string): { headline: string; body: string; icon: string } {
  const sentences = paragraph.split(/(?<=[.!?])\s+/)
  const headline = sentences[0]?.trim() ?? paragraph.slice(0, 80)
  const body     = sentences.slice(1).join(' ').trim() || paragraph.slice(headline.length).trim()
  // Pick icon by trend keyword
  const t = paragraph.toLowerCase()
  let icon = '📊'
  if (/\brevenue|sales|conversion/.test(t))               icon = '💰'
  else if (/\btraffic|sessions|click/.test(t))            icon = '🚀'
  else if (/\bdrop|decline|fell|lost/.test(t))            icon = '📉'
  else if (/\bgrew|gain|rose|improved/.test(t))           icon = '📈'
  else if (/\btool|api|integration|broken/.test(t))       icon = '🛠️'
  else if (/\bcompet|rival|market share/.test(t))         icon = '⚔️'
  else if (/\bcontent|brief|article|page/.test(t))        icon = '📝'
  else if (/\binvestigate|monitor|watch|risk/.test(t))    icon = '⚠️'
  return { headline: headline.replace(/[.!?]+$/, ''), body, icon }
}

function deriveHighlights(narrative: string): NarrativeHighlight[] {
  const paragraphs = narrative.split(/\n\n+/).map(p => p.trim()).filter(Boolean).slice(0, 6)
  return paragraphs.map(p => {
    const { headline, body, icon } = extractHeadline(p)
    return {
      trend:    classifyTrend(p),
      headline,
      body:     body.length > 320 ? body.slice(0, 317) + '…' : body,
      icon,
    }
  })
}

function KeyTakeawaysSection({ narrative, monthLabel }: { narrative: string; monthLabel: string }) {
  const highlights = useMemo(() => deriveHighlights(narrative), [narrative])
  if (highlights.length === 0) return null

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-red-400 font-semibold">Key Takeaways</p>
          <h3 className="text-lg font-bold text-white mt-0.5">What happened in {monthLabel}</h3>
        </div>
        <span className="text-[10px] text-gray-600">Auto-derived from AI narrative</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {highlights.map((h, i) => {
          const theme = TREND_THEME[h.trend]
          return (
            <article key={i} className="bg-gray-800/60 rounded-lg overflow-hidden border border-gray-800">
              <div className={`h-1 ${theme.stripe}`} />
              <div className="p-3">
                <div className="flex items-start justify-between mb-2">
                  <span className="text-xl">{h.icon}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${theme.badge}`}>
                    {theme.label}
                  </span>
                </div>
                <h4 className="text-white font-semibold text-sm leading-tight mb-1.5">{h.headline}</h4>
                {h.body && <p className="text-gray-400 text-xs leading-relaxed">{h.body}</p>}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

// ── v2 — Action Plan card grid (mirrors PPTX slide 8) ──────────────────────
//
// Galih's PPTX shows action items as numbered cards in 2-col grid with
// category labels (FOUNDATION / GROWTH / DEFENSE / VELOCITY) + P0/P1/P2
// priority badges. The existing /reports/monthly page already has an
// `<ActionPlan raw={...} />` numbered list — this replaces it with a card
// grid mirroring the PPTX. We parse the markdown action plan via the same
// regex used in pptx-builder.

interface ActionItemCard {
  number:   number
  title:    string
  body:     string
  priority: 'P0' | 'P1' | 'P2'
  category: string
}

function parseActionPlanCards(raw: string): ActionItemCard[] {
  const lines = raw.split('\n').filter(l => l.trim())
  const cards: ActionItemCard[] = []
  let current: ActionItemCard | null = null

  for (const line of lines) {
    // Match "1. **Title** — body" or "1. Title — body"
    const numMatch = line.match(/^(\d+)\.\s+\**([^*—\-]+?)\**\s*[—\-–]\s*(.+)$/)
    if (numMatch) {
      if (current) cards.push(current)
      const [, numStr, title, body] = numMatch
      // Heuristic priority + category
      const lc = (title + ' ' + body).toLowerCase()
      const priority: 'P0' | 'P1' | 'P2' =
        /\b(critical|urgent|blocking|must|p0|asap)\b/.test(lc) ? 'P0' :
        /\b(important|recover|fix|resolve|p1)\b/.test(lc)      ? 'P1' :
                                                                 'P2'
      const category =
        /\b(diagnose|measure|tracking|tooling|integrate|infra)\b/.test(lc) ? 'FOUNDATION' :
        /\b(launch|new|create|build|expand)\b/.test(lc)                    ? 'GROWTH'    :
        /\b(refresh|recover|defend|investigate|protect)\b/.test(lc)        ? 'DEFENSE'   :
        /\b(execute|ship|clear|backlog|velocity)\b/.test(lc)               ? 'VELOCITY'  :
                                                                              'EXECUTE'
      current = { number: parseInt(numStr, 10), title: title.trim(), body: body.trim(), priority, category }
    } else if (current) {
      current.body += ' ' + line.trim()
    }
  }
  if (current) cards.push(current)
  return cards
}

const PRIORITY_THEME: Record<ActionItemCard['priority'], string> = {
  P0: 'bg-red-500/15 text-red-300 border-red-500/30',
  P1: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  P2: 'bg-gray-700/40 text-gray-400 border-gray-700',
}

function ActionPlanCardsSection({ raw }: { raw: string }) {
  const cards = useMemo(() => parseActionPlanCards(raw), [raw])
  if (cards.length === 0) {
    // Fallback to existing prose-based ActionPlan
    return <ActionPlan raw={raw} />
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {cards.map(c => {
        const stripe = c.priority === 'P0' ? 'bg-red-500' : c.priority === 'P1' ? 'bg-amber-500' : 'bg-gray-500'
        const badge  = PRIORITY_THEME[c.priority]
        return (
          <article key={c.number} className="bg-gray-800/60 rounded-lg overflow-hidden border border-gray-800">
            <div className="flex items-stretch">
              <div className={`w-1.5 ${stripe} flex-shrink-0`} />
              <div className="flex-1 p-3 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-700 text-white text-xs font-bold flex-shrink-0">
                    {c.number}
                  </span>
                  <span className="text-[9px] uppercase tracking-widest text-gray-500 font-semibold">{c.category}</span>
                  <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${badge}`}>
                    {c.priority}
                  </span>
                </div>
                <h4 className="text-white font-semibold text-sm leading-tight mb-1">{c.title}</h4>
                <p className="text-gray-400 text-xs leading-relaxed">{c.body}</p>
              </div>
            </div>
          </article>
        )
      })}
    </div>
  )
}

// ── v2 — Tracked-product ranking analysis card ────────────────────────────
function RankingAnalysisSection({ tr }: { tr: TrackedRankings }) {
  const buckets = [
    { label: 'Top 3',  cur: tr.bucketsCur.top3,  prev: tr.bucketsPrev.top3 },
    { label: 'Top 5',  cur: tr.bucketsCur.top5,  prev: tr.bucketsPrev.top5 },
    { label: 'Top 10', cur: tr.bucketsCur.top10, prev: tr.bucketsPrev.top10 },
    { label: 'Top 20', cur: tr.bucketsCur.top20, prev: tr.bucketsPrev.top20 },
  ]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">🎯 Tracked Product Rankings</h3>
        <p className="text-[10px] text-gray-500">{tr.bucketsCur.ranked}/{tr.bucketsCur.total} keywords ranked · DataForSEO daily SERP</p>
      </div>

      {/* Bucket cards */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {buckets.map(b => {
          const delta = b.cur - b.prev
          return (
            <div key={b.label} className="bg-gray-800 rounded-lg p-3 text-center">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">{b.label}</p>
              <p className="text-2xl font-bold text-white mt-0.5">{b.cur}</p>
              <p className={`text-[11px] font-medium mt-0.5 ${delta > 0 ? 'text-green-400' : delta < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                {delta > 0 ? `+${delta}` : delta < 0 ? delta : '—'} <span className="text-gray-600">vs prev</span>
              </p>
            </div>
          )
        })}
      </div>

      {/* Top movers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <p className="text-[10px] text-green-400 uppercase tracking-wider font-semibold mb-2">▲ Top Improvers</p>
          {tr.topImprovers.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No improvements yet — daily history needs more days.</p>
          ) : (
            <ul className="space-y-1.5">
              {tr.topImprovers.slice(0, 6).map(m => (
                <li key={m.keyword + m.productName} className="flex items-start gap-2 text-xs">
                  <span className="text-green-400 font-bold w-12 flex-shrink-0">▲{m.movement}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium truncate" title={m.keyword}>{m.keyword}</p>
                    <p className="text-gray-500 truncate text-[11px]">{m.productName} · pos {m.curPosition}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-[10px] text-red-400 uppercase tracking-wider font-semibold mb-2">▼ Top Droppers</p>
          {tr.topDroppers.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No drops detected — nice.</p>
          ) : (
            <ul className="space-y-1.5">
              {tr.topDroppers.slice(0, 6).map(m => (
                <li key={m.keyword + m.productName} className="flex items-start gap-2 text-xs">
                  <span className="text-red-400 font-bold w-12 flex-shrink-0">▼{Math.abs(m.movement ?? 0)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium truncate" title={m.keyword}>{m.keyword}</p>
                    <p className="text-gray-500 truncate text-[11px]">{m.productName} · pos {m.curPosition ?? '—'}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* AI action plan (monthly only) */}
      {tr.actionPlan && tr.actionPlan.length > 0 && (
        <div className="mt-5 pt-5 border-t border-gray-800">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-3">🤖 AI-generated Action Plan</p>
          <div className="space-y-2">
            {tr.actionPlan.slice(0, 6).map((a, i) => {
              const pColor =
                a.priority === 'P0' ? 'bg-red-500/10 text-red-300 border-red-500/30' :
                a.priority === 'P1' ? 'bg-amber-500/10 text-amber-300 border-amber-500/30' :
                                      'bg-gray-700/30 text-gray-400 border-gray-700'
              return (
                <div key={i} className="bg-gray-800/60 border border-gray-800 rounded-lg p-3 text-xs">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${pColor}`}>
                      {a.priority}
                    </span>
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">{a.category}</span>
                    <span className="text-white font-medium">&ldquo;{a.keyword}&rdquo;</span>
                    {a.curPosition != null && <span className="text-gray-500 text-[10px]">pos {a.curPosition}</span>}
                    {a.movement != null && (
                      <span className={`text-[10px] font-semibold ${a.movement > 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {a.movement > 0 ? `▲${a.movement}` : `▼${Math.abs(a.movement)}`}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-300 leading-relaxed">{a.recommendation}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ── v2 — Experiments snapshot card ────────────────────────────────────────
function ExperimentsSnapshotSection({ ex }: { ex: ExperimentsSnapshot }) {
  const cols: { key: 'start' | 'continue' | 'stop'; label: string; icon: string; tint: string; items: ExperimentBrief[] }[] = [
    { key: 'start',    label: 'Start',    icon: '🌱', tint: 'border-green-500/30 bg-green-500/5', items: ex.start },
    { key: 'continue', label: 'Continue', icon: '🔄', tint: 'border-blue-500/30 bg-blue-500/5',   items: ex.continue },
    { key: 'stop',     label: 'Stop',     icon: '🛑', tint: 'border-red-500/30 bg-red-500/5',     items: ex.stop },
  ]
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-white">🧪 Experiments — Start / Stop / Continue</h3>
        <a href="/experiments" className="text-xs text-red-400 hover:text-red-300 transition">Manage →</a>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cols.map(c => (
          <section key={c.key} className={`rounded-xl border ${c.tint} p-3`}>
            <header className="flex items-center justify-between mb-2 px-1">
              <h4 className="text-white font-semibold text-xs flex items-center gap-1.5"><span>{c.icon}</span>{c.label}</h4>
              <span className="text-[10px] text-gray-500">{c.items.length}</span>
            </header>
            <ul className="space-y-2">
              {c.items.length === 0 && (
                <li className="text-[11px] text-gray-600 italic px-1 py-3 text-center">
                  {c.key === 'start' ? 'No new ideas this period.' : c.key === 'continue' ? 'Nothing carried over.' : 'No experiments stopped.'}
                </li>
              )}
              {c.items.slice(0, 5).map(it => (
                <li key={it.id} className="bg-gray-900/70 border border-gray-800 rounded-md p-2 text-[11px]">
                  <p className="text-white font-medium leading-tight">{it.title}</p>
                  {(it.hypothesis || it.success_metric || it.decision_notes) && (
                    <p className="text-gray-400 mt-0.5 line-clamp-2">{it.decision_notes ?? it.success_metric ?? it.hypothesis}</p>
                  )}
                  {(it.category || it.outcome || it.source === 'mimir') && (
                    <div className="mt-1 flex gap-1.5 flex-wrap">
                      {it.category && <span className="text-[9px] uppercase tracking-wider text-gray-500">{it.category}</span>}
                      {it.outcome  && <span className="text-[9px] uppercase tracking-wider text-amber-400">{it.outcome}</span>}
                      {it.source === 'mimir' && <span className="text-[9px] uppercase tracking-wider text-amber-300">🪶 Mimir</span>}
                    </div>
                  )}
                </li>
              ))}
              {c.items.length > 5 && (
                <li className="text-[10px] text-gray-600 italic px-1">+ {c.items.length - 5} more</li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MonthlyReportPage({ site = 'g2g' }: { site?: string }) {
  const [reports, setReports]             = useState<ReportSummary[]>([])
  const [selectedId, setSelectedId]       = useState<string | null>(null)
  const [report, setReport]               = useState<MonthlyReport | null>(null)
  const [loadingList, setLoadingList]     = useState(true)
  const [loadingReport, setLoadingReport] = useState(false)
  const [generating, setGenerating]       = useState(false)
  // Sprint #358 — 'data' = STAGE 1 (GSC/GA4/SEMrush gather), 'narrative' =
  // STAGE 2 (Anthropic AI summary). Drives the spinner copy + progress bar
  // so the user knows what's happening across the two-stage flow.
  const [generatingStage, setGeneratingStage] = useState<'data' | 'narrative' | null>(null)
  const [error, setError]                 = useState<string | null>(null)
  const [showPicker, setShowPicker]       = useState(false)
  // PPTX export state
  const [exportingPptx, setExportingPptx] = useState(false)
  const [pptxError,     setPptxError]     = useState<string | null>(null)

  const def = getDefaultMonth()
  const [pickYear,  setPickYear]  = useState(def.year)
  const [pickMonth, setPickMonth] = useState(def.month)

  // ── Load list ────────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch(`/api/reports/monthly?site=${site}`)
      if (res.ok) {
        const { reports: list } = await res.json()
        setReports(list ?? [])
        if (list?.length && !selectedId) setSelectedId(list[0].id)
      }
    } catch { /* silent */ }
    finally { setLoadingList(false) }
  }, [site]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadList() }, [loadList])

  // ── Load single report ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedId) return
    setLoadingReport(true)
    setReport(null)
    setPptxError(null)
    fetch(`/api/reports/monthly?id=${selectedId}`)
      .then(r => r.json())
      .then(({ report: r }) => { setReport(r) })
      .catch(() => {})
      .finally(() => setLoadingReport(false))
  }, [selectedId])

  // ── Export PPTX ──────────────────────────────────────────────────────────────
  async function exportPptx() {
    if (!selectedId) return
    setExportingPptx(true)
    setPptxError(null)
    try {
      const res = await fetch('/api/reports/monthly/export-pptx', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: selectedId }),
      })
      if (!res.ok) {
        // Try JSON first (our /api route returns JSON errors). If that fails
        // (e.g. Vercel platform-level error like 504 timeout returns HTML),
        // fall back to text body. Either way, surface the REAL message + HTTP
        // status so the user knows what happened.
        const ct = res.headers.get('content-type') ?? ''
        let detail = ''
        if (ct.includes('application/json')) {
          const data = await res.json().catch(() => null) as { error?: string } | null
          detail = data?.error ?? ''
        }
        if (!detail) {
          // Read text — Vercel error pages, body too short, etc.
          detail = (await res.text().catch(() => '')).trim().slice(0, 500)
        }
        setPptxError(detail
          ? `HTTP ${res.status}: ${detail}`
          : `HTTP ${res.status}: PPTX export failed (no error body returned)`)
        return
      }
      // Success — stream is the raw PPTX binary. Trigger browser download.
      const blob     = await res.blob()
      const filename = res.headers.get('Content-Disposition')
        ?.match(/filename="([^"]+)"/)?.[1] ?? 'Monthly-Report.pptx'
      const url      = URL.createObjectURL(blob)
      const a        = document.createElement('a')
      a.href         = url
      a.download     = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      setPptxError(String(e))
    } finally {
      setExportingPptx(false)
    }
  }

  // ── Generate (two-stage: data first, then AI narrative) ──────────────────
  async function generate() {
    setGenerating(true)
    setGeneratingStage('data')
    setError(null)
    try {
      // STAGE 1: gather GSC/GA4/SEMrush/etc + save row (no AI yet, fits 60s)
      const res = await fetch('/api/reports/monthly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, year: pickYear, month: pickMonth }),
      })

      // Sprint #357 MONTHLY.JSON.ERR — Vercel can return non-JSON when the
      // function times out / OOMs (HTML "An error occurred…" page).
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        let detail = ''
        if (ct.includes('application/json')) {
          const data = await res.json().catch(() => null) as { error?: string } | null
          detail = data?.error ?? ''
        }
        if (!detail) detail = (await res.text().catch(() => '')).trim().slice(0, 500)
        if (/An error occurred|FUNCTION_INVOCATION_TIMEOUT|504/i.test(detail)) {
          setError(`HTTP ${res.status}: Data fetch timed out. Try again — if this persists, contact engineering.`)
        } else {
          setError(detail
            ? `HTTP ${res.status}: ${detail}`
            : `HTTP ${res.status}: Report generation failed (no error body returned)`)
        }
        return
      }

      const { report: r, error: e, needs_narrative } = await res.json() as {
        report?: { id: string; month_start: string; ai_narrative: string; [k: string]: unknown }
        error?: string
        needs_narrative?: boolean
      }
      if (e) { setError(e); return }
      if (!r) { setError('Unexpected response shape'); return }

      // Stage 1 done — insert the row, select it, refresh list. The user
      // sees the data report immediately; AI narrative arrives in stage 2.
      setReports(prev => {
        const filtered = prev.filter(p => p.month_start !== r.month_start)
        return [r as typeof prev[number], ...filtered]
      })
      setSelectedId(r.id)
      setReport(r as typeof report)
      setShowPicker(false)

      // STAGE 2: AI narrative — fire-and-await separately so it has its own
      // 60s budget. UI flips to "Generating AI summary…" while this runs.
      if (needs_narrative !== false) {
        setGeneratingStage('narrative')
        try {
          const nres = await fetch('/api/reports/monthly/narrative', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: r.id }),
          })
          const nct = nres.headers.get('content-type') ?? ''
          if (!nres.ok || !nct.includes('application/json')) {
            const txt = (await nres.text().catch(() => '')).slice(0, 300)
            console.warn('[monthly] narrative failed:', nres.status, txt)
            // Soft-fail — user already has the data report. Show a non-fatal
            // notice and let them retry via the dedicated button (below).
            setError(`AI summary generation failed (HTTP ${nres.status}). The data report is ready; click "Regenerate AI summary" to try again.`)
            return
          }
          const { ok, report: updated, error: nerr } = await nres.json() as {
            ok: boolean
            report?: typeof report
            error?: string
          }
          if (!ok || !updated) {
            setError(nerr ?? 'AI summary failed but data report is ready')
            return
          }
          setReport(updated)
          setReports(prev => prev.map(p => p.id === r.id ? (updated as typeof p) : p))
        } catch (nerr) {
          console.warn('[monthly] narrative threw:', nerr)
          setError('AI summary generation threw. Data report is ready; retry via "Regenerate AI summary".')
        }
      }
    } catch (err: unknown) {
      setError(String(err))
    } finally {
      setGenerating(false)
      setGeneratingStage(null)
    }
  }

  // Sprint #358 — manual retry handler. Called from the "Regenerate AI
  // summary" button shown when ai_narrative is empty (failure case OR
  // user just wants a fresh take with same data).
  async function regenerateNarrative() {
    if (!selectedId) return
    setGenerating(true)
    setGeneratingStage('narrative')
    setError(null)
    try {
      const res = await fetch('/api/reports/monthly/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedId }),
      })
      const ct = res.headers.get('content-type') ?? ''
      if (!res.ok || !ct.includes('application/json')) {
        const txt = (await res.text().catch(() => '')).slice(0, 300)
        setError(`AI summary failed (HTTP ${res.status}): ${txt || 'unknown error'}`)
        return
      }
      const { ok, report: updated, error: nerr } = await res.json() as {
        ok: boolean
        report?: typeof report
        error?: string
      }
      if (!ok || !updated) { setError(nerr ?? 'AI summary failed'); return }
      setReport(updated)
      setReports(prev => prev.map(p => p.id === selectedId ? (updated as typeof p) : p))
    } catch (err) {
      setError(String(err))
    } finally {
      setGenerating(false)
      setGeneratingStage(null)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async function deleteReport(id: string) {
    if (!confirm('Delete this report?')) return
    await fetch(`/api/reports/monthly?id=${id}`, { method: 'DELETE' })
    const next = reports.filter(r => r.id !== id)
    setReports(next)
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? null)
      if (!next.length) setReport(null)
    }
  }

  const d = report?.report_data
  const isLoading = loadingReport || generating

  return (
    <div className="p-8 max-w-5xl print:p-0 print:max-w-none">

      {/* ── Header ── */}
      <div className="mb-6 flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-white">📅 Monthly SEO Report</h1>
          <p className="text-gray-400 text-sm mt-1">
            Full-month organic performance with AI executive summary and action plan.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {report && (
            <MimirPanel
              pageContext={{ kind: 'monthly_report', id: report.id }}
              trigger="🪶 Ask Mimir"
            />
          )}
          {report && (
            <button
              onClick={() => window.print()}
              className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-2 rounded-lg transition flex items-center gap-1.5"
            >
              🖨️ Export PDF
            </button>
          )}
          {report && (
            <button
              onClick={exportPptx}
              disabled={exportingPptx}
              className="text-xs text-orange-400 hover:text-orange-300 border border-orange-700/40 hover:border-orange-500 disabled:opacity-50 px-3 py-2 rounded-lg transition flex items-center gap-1.5"
              title="Generate and download a stakeholder-ready PPTX deck"
            >
              {exportingPptx ? <><span className="animate-spin">⟳</span> Building…</> : <>📊 Export PPTX</>}
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowPicker(p => !p)}
              className="text-xs bg-red-700 hover:bg-red-600 text-white px-3 py-2 rounded-lg transition flex items-center gap-1.5 font-medium"
            >
              ✨ Generate Report
            </button>
            {showPicker && (
              <div className="absolute right-0 top-full mt-2 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-4 w-64">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Select Month</p>
                <div className="flex gap-2 mb-3">
                  <select
                    value={pickMonth}
                    onChange={e => setPickMonth(Number(e.target.value))}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                  >
                    {MONTH_NAMES.map((m, i) => (
                      <option key={i} value={i + 1}>{m}</option>
                    ))}
                  </select>
                  <select
                    value={pickYear}
                    onChange={e => setPickYear(Number(e.target.value))}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                  >
                    {[2024, 2025, 2026].map(y => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={generate}
                  disabled={generating}
                  className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold py-2 rounded-lg transition"
                >
                  {generating
                    ? (generatingStage === 'narrative'
                        ? '🪄 Generating AI summary…'
                        : '⏳ Gathering data…')
                    : '🚀 Generate'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-red-400 text-sm print:hidden">
          {error}
        </div>
      )}

      {pptxError && (
        <div className="mb-4 bg-orange-500/10 border border-orange-500/30 rounded-xl p-4 text-orange-300 text-sm print:hidden flex items-start gap-2">
          <span>⚠️</span>
          <div className="flex-1">
            <p className="font-medium">PPTX export failed</p>
            <p className="mt-1 text-xs text-orange-200/80">{pptxError}</p>
          </div>
          <button
            onClick={() => setPptxError(null)}
            className="text-orange-400 hover:text-orange-200 text-xs ml-2"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex gap-6">

        {/* ── Sidebar ── */}
        <div className="w-52 flex-shrink-0 print:hidden">
          {loadingList ? (
            <div className="flex justify-center py-8"><LottieLoader size={40} /></div>
          ) : reports.length === 0 ? (
            <div className="text-gray-600 text-xs text-center py-8">No reports yet.<br />Generate your first one!</div>
          ) : (
            <ul className="space-y-1">
              {reports.map(r => {
                const d = new Date(r.month_start + 'T00:00:00')
                const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => setSelectedId(r.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition group ${
                        selectedId === r.id
                          ? 'bg-red-700/20 border border-red-700/40 text-white'
                          : 'text-gray-400 hover:text-white hover:bg-gray-800'
                      }`}
                    >
                      <p className="font-semibold">{label}</p>
                      <p className="text-gray-500 text-[10px] mt-0.5">
                        Generated {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </button>
                    {selectedId === r.id && (
                      <button
                        onClick={() => deleteReport(r.id)}
                        className="w-full text-center text-[10px] text-gray-600 hover:text-red-400 py-0.5 transition"
                      >
                        Delete
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0">
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-20">
              <LottieLoader size={80} text={generating ? 'Generating monthly report… (~45s)' : 'Loading…'} />
            </div>
          )}

          {!isLoading && !report && !loadingList && (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
              <p className="text-3xl mb-3">📅</p>
              <p className="text-white font-semibold mb-1">No report selected</p>
              <p className="text-gray-400 text-sm">Generate your first monthly report using the button above.</p>
            </div>
          )}

          {!isLoading && report && d && (
            <div className="space-y-6">

              {/* Print header */}
              <div className="hidden print:block mb-6">
                <h1 className="text-2xl font-bold">📅 Monthly SEO Report — G2G.com</h1>
                <p className="text-gray-500 text-sm">{d.monthLabel}</p>
              </div>

              {/* ── Month header ── */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">{d.monthLabel}</h2>
                  <p className="text-xs text-gray-500">
                    vs {d.prevMonthLabel} · Generated {new Date(report.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>

              {/* ── KPI Cards — 2 rows of 3 ── */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <StatCard icon="🖱️" label="Clicks"
                  value={fmt(d.gsc.monthClicks)} pct={d.gsc.clicksPct}
                  sub={`prev ${fmt(d.gsc.prevMonthClicks)}`} />
                <StatCard icon="👁️" label="Impressions"
                  value={fmt(d.gsc.monthImpressions)} pct={d.gsc.impressionsPct}
                  sub={`avg pos ${d.gsc.avgPosition}`} />
                <StatCard icon="🎯" label="CTR"
                  value={`${d.gsc.monthCtr}%`} pct={d.gsc.ctrPct}
                  sub={`prev ${d.gsc.prevCtr}%`} />
                {d.ga4 ? (
                  <>
                    <StatCard icon="📈" label="Organic Sessions"
                      value={fmt(d.ga4.monthSessions)} pct={d.ga4.sessionsPct}
                      sub={`prev ${fmt(d.ga4.prevSessions)}`} />
                    <StatCard icon="💰" label="Revenue"
                      value={fmtUsd(d.ga4.totalRevenue)} pct={d.ga4.revenuePct}
                      sub={`prev ${fmtUsd(d.ga4.prevRevenue)}`} />
                    <StatCard icon="🛒" label="Conversions"
                      value={fmt(d.ga4.totalConversions)} pct={d.ga4.conversionsPct}
                      sub={`prev ${fmt(d.ga4.prevConversions)}`} />
                  </>
                ) : (
                  <StatCard icon="📈" label="Organic Sessions" value="—" sub="GA4 not connected" />
                )}
              </div>

              {/* ── Quick Summary (bullet points) ── */}
              <QuickSummary d={d} report={report} />

              {/* ── Agent Activity (auto-hidden if no activity) ── */}
              <AgentActivitySummary insights={d.agentInsights ?? null} />

              {/* ── Keyword Rankings ── */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-5">
                  <h3 className="text-sm font-semibold text-white">🎯 Keyword Rankings</h3>
                  <span className="text-xs text-gray-500">{fmt(d.semrush.totalKeywords)} tracked</span>
                </div>
                <div className="grid grid-cols-4 gap-3 mb-5">
                  {[
                    { label: 'Top 3', value: d.semrush.top3, color: 'text-green-400' },
                    { label: 'Top 10', value: d.semrush.top10, color: 'text-blue-400' },
                    { label: 'Top 20', value: d.semrush.top20, color: 'text-yellow-400' },
                    { label: 'Avg Pos', value: d.semrush.avgPosition, color: 'text-gray-300' },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>

                {(d.semrush.topMoversUp.length > 0 || d.semrush.topMoversDown.length > 0) && (
                  <div className="grid grid-cols-2 gap-4">
                    {d.semrush.topMoversUp.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-green-400 uppercase tracking-wider mb-2">Improved this month</p>
                        <ul className="space-y-1.5">
                          {d.semrush.topMoversUp.slice(0, 6).map(k => (
                            <li key={k.keyword} className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-300 truncate">{k.keyword}</p>
                                <p className="text-[10px] text-gray-500">pos {k.position} · {fmt(k.volume)} vol</p>
                              </div>
                              <span className="text-xs font-semibold text-green-400 flex-shrink-0">↑{Math.abs(k.positionDiff)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {d.semrush.topMoversDown.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-2">Dropped this month</p>
                        <ul className="space-y-1.5">
                          {d.semrush.topMoversDown.slice(0, 6).map(k => (
                            <li key={k.keyword} className="flex items-center gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs text-gray-300 truncate">{k.keyword}</p>
                                <p className="text-[10px] text-gray-500">pos {k.position} · {fmt(k.volume)} vol</p>
                              </div>
                              <span className="text-xs font-semibold text-red-400 flex-shrink-0">↓{k.positionDiff}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Traffic + Movers ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Top pages by clicks */}
                {d.gsc.topPagesByClicks.length > 0 && (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                    <h3 className="text-sm font-semibold text-white mb-4">🔝 Top Pages by Clicks</h3>
                    <ul className="space-y-2">
                      {d.gsc.topPagesByClicks.slice(0, 8).map(p => {
                        const maxClicks = d.gsc.topPagesByClicks[0]?.clicks ?? 1
                        return (
                          <li key={p.page}>
                            <div className="flex items-center gap-2 mb-0.5">
                              <p className="text-xs text-gray-300 truncate flex-1">{fmtUrl(p.page)}</p>
                              <span className="text-xs font-semibold text-white flex-shrink-0">{fmt(p.clicks)}</span>
                            </div>
                            <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.round((p.clicks / maxClicks) * 100)}%` }} />
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}

                {/* GSC Movers */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">📉 MoM Traffic Movers</h3>
                  {d.gsc.topGainers.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-green-400 uppercase tracking-wider mb-2">Gainers</p>
                      <ul className="space-y-2 mb-4">
                        {d.gsc.topGainers.slice(0, 5).map(g => (
                          <li key={g.page} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-300 truncate">{fmtUrl(g.page)}</p>
                              <p className="text-[10px] text-gray-500">{fmt(g.clicks)} clicks</p>
                            </div>
                            <span className="text-xs font-semibold text-green-400 flex-shrink-0">+{fmt(g.delta)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {d.gsc.topDroppers.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-2">Droppers</p>
                      <ul className="space-y-2">
                        {d.gsc.topDroppers.slice(0, 5).map(g => (
                          <li key={g.page} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-300 truncate">{fmtUrl(g.page)}</p>
                              <p className="text-[10px] text-gray-500">{fmt(g.clicks)} clicks</p>
                            </div>
                            <span className="text-xs font-semibold text-red-400 flex-shrink-0">{fmt(g.delta)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {d.gsc.topGainers.length === 0 && d.gsc.topDroppers.length === 0 && (
                    <p className="text-xs text-gray-500">No GSC snapshot data for this month.</p>
                  )}
                </div>
              </div>

              {/* ── GA4 top pages — v2: vs Last Month delta column ── */}
              {d.ga4 && d.ga4.topPages.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">📄 Top Organic Category Pages (GA4)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Page</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">Sessions</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-28">vs Last Month</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-24">Conversions</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-24">Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const maxSessions = Math.max(...d.ga4!.topPages.map(p => p.sessions), 1)
                          return d.ga4!.topPages.map(p => {
                            // Delta cell: NEW badge when prev=0, red when drop >20%
                            const hasPrev = p.prevSessions !== undefined
                            const isNew   = hasPrev && (p.prevSessions ?? 0) === 0 && p.sessions > 0
                            const pct     = p.sessionsPct ?? null
                            const isBigDrop = pct != null && pct <= -20
                            return (
                              <tr key={p.pagePath} className="border-b border-gray-800/50 last:border-0">
                                <td className="py-2 pr-3">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-gray-300 truncate max-w-xs">{p.pagePath}</p>
                                    <div className="h-1 bg-gray-800 rounded-full mt-1 overflow-hidden w-full">
                                      <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.round((p.sessions / maxSessions) * 100)}%` }} />
                                    </div>
                                  </div>
                                </td>
                                <td className="py-2 text-right text-gray-300 font-medium">{fmt(p.sessions)}</td>
                                <td className="py-2 text-right">
                                  {!hasPrev ? (
                                    <span className="text-gray-700">—</span>
                                  ) : isNew ? (
                                    <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/30">NEW</span>
                                  ) : pct == null ? (
                                    <span className="text-gray-700">—</span>
                                  ) : (
                                    <span className={`font-semibold ${
                                      pct >= 20  ? 'text-green-400' :
                                      pct >= 0   ? 'text-green-500' :
                                      isBigDrop  ? 'text-red-400 font-bold' :
                                                   'text-red-500'
                                    }`}>
                                      {pct >= 0 ? '▲' : '▼'}{Math.abs(pct)}%
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 text-right">
                                  <span className={p.conversions > 0 ? 'text-green-400 font-medium' : 'text-gray-600'}>
                                    {p.conversions > 0 ? fmt(p.conversions) : '—'}
                                  </span>
                                </td>
                                <td className="py-2 text-right">
                                  <span className={p.revenue > 0 ? 'text-amber-400 font-medium' : 'text-gray-600'}>
                                    {p.revenue > 0 ? fmtUsd(p.revenue) : '—'}
                                  </span>
                                </td>
                              </tr>
                            )
                          })
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Channel Breakdown (v2) ── */}
              {d.channelBreakdown && d.channelBreakdown.rows.length > 0 && (
                <ChannelBreakdownSection cb={d.channelBreakdown} curLabel={d.monthLabel} prevLabel={d.prevMonthLabel} />
              )}

              {/* ── Tracked product ranking analysis (v2) ── */}
              {d.trackedRankings && d.trackedRankings.bucketsCur.total > 0 && (
                <RankingAnalysisSection tr={d.trackedRankings} />
              )}

              {/* ── Experiments — Start / Stop / Continue (v2) ── */}
              {d.experiments && (d.experiments.start.length > 0 || d.experiments.continue.length > 0 || d.experiments.stop.length > 0) && (
                <ExperimentsSnapshotSection ex={d.experiments} />
              )}

              {/* ── Paid Backlinks ── */}
              {d.backlinks && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="text-sm font-semibold text-white">🔗 Paid Backlinks</h3>
                    <a href="/link-building" className="text-xs text-red-400 hover:text-red-300 transition">
                      Manage →
                    </a>
                  </div>

                  {/* Summary stats */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-white">{d.backlinks.totalActive}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Active links</p>
                    </div>
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-green-400">{d.backlinks.newThisMonth}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">New this month</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-amber-400">
                        {fmtCostByCurrency(d.backlinks.costsByCurrency) !== '—'
                          ? fmtCostByCurrency(d.backlinks.costsByCurrency)
                          : (d.backlinks.totalCostThisMonth > 0 ? fmtUsd(d.backlinks.totalCostThisMonth) : '—')}
                      </p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Cost this month</p>
                    </div>
                    <div className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className="text-xl font-bold text-blue-400">
                        {d.backlinks.avgPositionImprovement != null
                          ? `↑${d.backlinks.avgPositionImprovement}`
                          : '—'}
                      </p>
                      <p className="text-[10px] text-gray-500 mt-0.5">Avg pos. gain</p>
                    </div>
                  </div>

                  {/* Recently acquired links */}
                  {d.backlinks.recentLinks.length > 0 ? (
                    <>
                      <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
                        Links acquired this month
                      </p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="border-b border-gray-800">
                              <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Site</th>
                              <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Anchor</th>
                              <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Target Page</th>
                              <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">Position</th>
                              <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">Cost</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.backlinks.recentLinks.map((link, i) => {
                              const posDiff = (link.positionAtCreation != null && link.positionCurrent != null)
                                ? link.positionAtCreation - link.positionCurrent
                                : null
                              return (
                                <tr key={i} className="border-b border-gray-800/50 last:border-0">
                                  <td className="py-2 pr-3">
                                    <a href={link.externalUrl} target="_blank" rel="noopener noreferrer"
                                      className="text-blue-400 hover:text-blue-300 font-medium">
                                      {link.siteName}
                                    </a>
                                    {link.liveDate && (
                                      <p className="text-[10px] text-gray-600">{link.liveDate}</p>
                                    )}
                                  </td>
                                  <td className="py-2 pr-3">
                                    <span className="text-gray-300 italic">{link.anchorText}</span>
                                  </td>
                                  <td className="py-2 pr-3">
                                    <p className="text-gray-400 truncate max-w-[140px]">
                                      {link.targetPage.replace('https://www.g2g.com', '').replace('https://g2g.com', '') || link.targetPage}
                                    </p>
                                    {link.targetKeyword && (
                                      <p className="text-[10px] text-gray-600">kw: {link.targetKeyword}</p>
                                    )}
                                  </td>
                                  <td className="py-2 text-right">
                                    {link.positionCurrent != null ? (
                                      <div>
                                        <span className={`font-semibold ${link.positionCurrent <= 3 ? 'text-green-400' : link.positionCurrent <= 10 ? 'text-blue-400' : 'text-gray-300'}`}>
                                          #{link.positionCurrent}
                                        </span>
                                        {posDiff != null && posDiff !== 0 && (
                                          <span className={`ml-1 text-[10px] ${posDiff > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {posDiff > 0 ? `↑${posDiff}` : `↓${Math.abs(posDiff)}`}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-gray-600">—</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-right">
                                    <span className={link.costAmount != null && link.costAmount > 0 ? 'text-amber-400' : 'text-gray-600'}>
                                      {link.costAmount != null && link.costAmount > 0 ? fmtCost(link.costAmount, link.costCurrency) : '—'}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-gray-500">
                      No new backlinks recorded this month.{' '}
                      <a href="/link-building" className="text-red-400 hover:text-red-300">Add links →</a>
                    </p>
                  )}

                  {/* Warnings */}
                  {d.backlinks.brokenLinks > 0 && (
                    <div className="mt-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-start gap-2">
                      <span className="text-red-400 text-sm">⚠️</span>
                      <p className="text-xs text-red-400">
                        {d.backlinks.brokenLinks} broken link{d.backlinks.brokenLinks > 1 ? 's' : ''} detected. Check the{' '}
                        <a href="/link-building" className="underline hover:text-red-300">Link Building</a> page to fix them.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Action Items ── */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-4">✅ Action Items this Month</h3>
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: 'Created', value: d.actionItems.total, color: 'text-white' },
                    { label: 'Pending', value: d.actionItems.pending, color: 'text-yellow-400' },
                    { label: 'In Progress', value: d.actionItems.inProgress, color: 'text-blue-400' },
                    { label: 'Completed', value: d.actionItems.done, color: 'text-green-400' },
                  ].map(s => (
                    <div key={s.label} className="bg-gray-800 rounded-lg p-3 text-center">
                      <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Competitive SoV ── */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
                  <h3 className="text-sm font-semibold text-white">👁️ Share of Voice</h3>
                  {d.competitive.sovEstimated && d.competitive.sovTable.length > 0 && (
                    <span
                      className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/10 border border-yellow-500/30 text-yellow-300"
                      title="No SERP snapshots inside this report's month — falling back to the most recent 60 days. Run SERP tracking again during the target month for accurate values."
                    >
                      Estimated · using last 60d
                    </span>
                  )}
                </div>
                {d.competitive.sovTable.length > 0 ? (
                  <div className="space-y-2.5">
                    {d.competitive.sovTable.map(row => {
                      const isG2G = row.domain === 'g2g.com'
                      const maxSov = d.competitive.sovTable[0]?.sov ?? 1
                      return (
                        <div key={row.domain} className="flex items-center gap-3">
                          <div className="flex items-center gap-1.5 w-36 flex-shrink-0">
                            <img src={`https://www.google.com/s2/favicons?domain=${row.domain}&sz=16`} alt="" className="w-3 h-3 flex-shrink-0" />
                            <span className={`text-xs truncate ${isG2G ? 'text-white font-semibold' : 'text-gray-300'}`}>{row.domain}</span>
                          </div>
                          <div className="flex-1">
                            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${isG2G ? 'bg-red-600' : 'bg-gray-600'}`}
                                style={{ width: `${(row.sov / maxSov) * 100}%` }}
                              />
                            </div>
                          </div>
                          <span className={`text-xs font-semibold w-12 text-right flex-shrink-0 ${isG2G ? 'text-red-400' : 'text-gray-400'}`}>
                            {row.sov}%
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">
                    No SERP snapshot data for this month. Run the{' '}
                    <a href="/competitive/serp-tracker" className="text-red-400 hover:text-red-300">SERP Tracker</a>{' '}
                    to start tracking Share of Voice, or check the{' '}
                    <a href="/competitive/serp-tracker?tab=history" className="text-blue-400 hover:text-blue-300">📚 History tab</a>{' '}
                    for past runs.
                  </p>
                )}
                {d.competitive.sovTable.length > 0 && (
                  <p className="mt-3 pt-3 border-t border-gray-800 text-[11px] text-gray-600">
                    See <a href="/competitive/serp-tracker?tab=history" className="text-blue-400 hover:text-blue-300">📚 SERP History</a> for full timeline of every tracking run (by date, keyword, country).
                  </p>
                )}
              </div>

              {/* ── Key Takeaways (mirrors PPTX slide 4 — card grid) ── */}
              {report.ai_narrative && (
                <KeyTakeawaysSection
                  narrative={report.ai_narrative}
                  monthLabel={d.monthLabel}
                />
              )}

              {/* ── AI Action Plan — card grid (mirrors PPTX slide 8) ── */}
              {report.ai_action_plan && (
                <div className="bg-gradient-to-br from-red-950/30 to-gray-900 border border-red-800/30 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="text-base">🎯</span>
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Recommended Action Plan</h3>
                    <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">AI-recommended · Next month</span>
                  </div>
                  <ActionPlanCardsSection raw={report.ai_action_plan} />
                </div>
              )}

              {/* ── ✨ Executive Summary (full narrative — for deep reading) ── */}
              {report.ai_narrative && (
                <div className="bg-gradient-to-br from-gray-900 to-gray-900/80 border border-gray-700 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-base">✨</span>
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Executive Summary</h3>
                    <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Claude</span>
                  </div>
                  <div className="space-y-3">
                    {report.ai_narrative.split('\n\n').map((para, i) => (
                      <p key={i} className="text-sm text-gray-300 leading-relaxed">{para}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* Sprint #358 — AI summary missing / failed. Show a retry CTA
                  so the user isn't stuck. Two cases:
                    1. Generate just finished stage 1 but stage 2 errored —
                       error message already surfaced via top-level banner.
                    2. Legacy row, or user wants a fresh take. */}
              {!report.ai_narrative && (
                <div className="bg-gradient-to-br from-amber-950/40 to-gray-900 border border-amber-800/40 rounded-xl p-6">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl">🪄</span>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-white mb-1">AI summary not yet generated</h3>
                      <p className="text-xs text-gray-400 leading-relaxed mb-3">
                        The data report is ready. The AI executive summary &amp; action plan
                        haven&apos;t been generated for this report yet — click below to run them now.
                        (~30-50s, uses Claude Opus.)
                      </p>
                      <button
                        onClick={regenerateNarrative}
                        disabled={generating}
                        className="text-xs bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition font-medium"
                      >
                        {generating && generatingStage === 'narrative'
                          ? '⏳ Generating AI summary…'
                          : '🪄 Generate AI summary'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          )}
        </div>
      </div>

      {/* Print styles — match weekly + tweaks for monthly cadence */}
      <style jsx global>{`
        @media print {
          /* Preserve dark theme + colours when printing to PDF */
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color-adjust: exact !important;
          }
          html, body {
            background: #030712 !important;
            color: #f9fafb !important;
            font-size: 11px;
          }

          /* Page setup — A4 portrait with comfortable margins */
          @page {
            margin: 16mm 12mm 18mm 12mm;
            size: A4 portrait;
          }

          /* Hide app chrome */
          .print\\:hidden { display: none !important; }
          .print\\:block  { display: block !important; }
          aside, nav     { display: none !important; }

          /* Main layout: collapse sidebar, full width content */
          .flex.gap-6 { display: block !important; }

          /* Cards stay on one page where possible */
          .rounded-xl, .rounded-2xl, section { page-break-inside: avoid; break-inside: avoid; }

          /* Force page break before strategic narrative blocks so they
             don't get split across pages awkwardly. */
          h2 + section,
          h3 + section { page-break-inside: avoid; break-inside: avoid; }

          /* Tighter spacing */
          .space-y-6 > * + * { margin-top: 14px !important; }
          .p-5 { padding: 14px !important; }
          .p-6 { padding: 16px !important; }

          /* Force expected grid layouts in print (some are responsive-only) */
          .grid-cols-2, .md\\:grid-cols-2 { grid-template-columns: 1fr 1fr !important; }
          .md\\:grid-cols-3               { grid-template-columns: 1fr 1fr 1fr !important; }
          .md\\:grid-cols-4               { grid-template-columns: 1fr 1fr 1fr 1fr !important; }

          /* Trim oversized stat numbers so cards fit on the printed page */
          .text-3xl { font-size: 1.5rem  !important; }
          .text-2xl { font-size: 1.25rem !important; }

          /* Links: don't append visible URL after anchor text */
          a[href]:after { content: '' !important; }

          /* Tables: avoid splitting rows */
          tr { page-break-inside: avoid; break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}
