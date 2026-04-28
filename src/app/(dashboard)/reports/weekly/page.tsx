'use client'

import { useState, useEffect, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'
import AgentActivitySummary, { type AgentInsightsLite } from '@/components/reports/AgentActivitySummary'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GscData {
  weekClicks: number
  prevWeekClicks: number
  clicksPct: number | null
  weekImpressions: number
  prevWeekImpressions: number
  impressionsPct: number | null
  weekCtr?: number          // added in v2 — optional for old reports
  prevWeekCtr?: number
  ctrPct?: number | null
  avgPosition: number
  totalUniquePages: number
  topGainers: { page: string; delta: number; clicks: number }[]
  topDroppers: { page: string; delta: number; clicks: number }[]
}

interface Ga4Data {
  weekSessions: number
  prevWeekSessions: number
  sessionsPct: number | null
  engagedSessions: number
  bounceRate: number
  totalPurchases?: number
  prevPurchases?: number
  purchasesPct?: number | null
  totalRevenue?: number
  prevRevenue?: number
  revenuePct?: number | null
  topPages: { pagePath: string; sessions: number; purchases?: number; revenue?: number }[]
}

interface SemrushData {
  totalKeywords: number
  top3: number
  top10: number
  topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]
  topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[]
}

interface ActionItemsData {
  total: number
  pending: number
  inProgress: number
  done: number
  assignedThisWeek: number
  completedThisWeek: number
  byAssignee?: { email: string; assigned: number; completed: number; inProgress: number }[]
}

interface SovRow {
  domain: string
  sov: number
  keywords: number
  estimated?: boolean
}

interface DomainAuthority {
  organicKeywords: number
  organicTraffic: number
  organicCost: number
  rank: number
}

interface ReportData {
  weekStart: string
  weekEnd: string
  gsc: GscData
  ga4: Ga4Data | null
  ga4Error?: string | null
  semrush: SemrushData
  actionItems: ActionItemsData
  competitive: {
    trackedCompetitors?: { domain: string; name?: string }[]
    sovTable?: SovRow[]
    sovKeywordCount?: number
    sovEstimated?: boolean
  }
  domainAuthority?: DomainAuthority | null
  // AI sections stored in report_data (v2+)
  aiIssues?: string
  aiManagementPlan?: string
  aiTeamPlan?: string
  // Agent activity (v3+) — null when agents haven't run in window
  agentInsights?: AgentInsightsLite | null
}

interface WeeklyReport {
  id: string
  week_start: string
  week_end: string
  created_at: string
  report_data: ReportData
  ai_narrative: string
  ai_action_plan: string
}

interface ReportSummary {
  id: string
  week_start: string
  week_end: string
  created_at: string
  ai_narrative: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) { return n.toLocaleString() }
function fmtUsd(n: number) {
  if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`
  if (n >= 1000)    return `$${(n / 1000).toFixed(1)}K`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}
function pctBadge(pct: number | null) {
  if (pct == null) return null
  const up = pct >= 0
  return (
    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${up ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
      {up ? '↑' : '↓'}{Math.abs(pct)}%
    </span>
  )
}

// fmtUrl is defined inside the component to capture the site prop — see below

function weekLabel(start: string, end: string) {
  const s = new Date(start + 'T00:00:00')
  const e = new Date(end   + 'T00:00:00')
  return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}

function getDefaultWeek(): { start: string; end: string } {
  const now = new Date()
  const day = now.getDay()
  const daysSinceWed = (day + 4) % 7
  const lastWed = new Date(now)
  lastWed.setDate(now.getDate() - daysSinceWed)
  lastWed.setHours(0, 0, 0, 0)
  const thu = new Date(lastWed)
  thu.setDate(lastWed.getDate() - 6)
  return {
    start: thu.toISOString().slice(0, 10),
    end:   lastWed.toISOString().slice(0, 10),
  }
}

// Simple inline bar
function Bar({ value, max, color = 'bg-red-600' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden flex-1">
      <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
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

// ── Issues list renderer ──────────────────────────────────────────────────────
function IssuesList({ raw }: { raw: string }) {
  if (!raw) return null
  const bullets = raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('•') || l.startsWith('-') || l.startsWith('*'))
  if (!bullets.length) return <p className="text-sm text-gray-400">{raw}</p>
  return (
    <ul className="space-y-2">
      {bullets.map((line, i) => (
        <li key={i} className="flex gap-2 text-sm text-amber-200/80">
          <span className="text-amber-400 flex-shrink-0 mt-0.5">⚠</span>
          <span>{line.replace(/^[•\-*]\s*/, '')}</span>
        </li>
      ))}
    </ul>
  )
}

// ── Action plan renderer ──────────────────────────────────────────────────────
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

// ── Action Punch List ─────────────────────────────────────────────────────────
//
// Compact, action-only summary at the top of the report. Replaces the
// long-form AI Narrative as the FIRST thing the reader sees. The narrative
// + Issues block + Agent Activity Summary still exist but moved below this.
//
// Sources:
//   • aiIssues  — extract first 3 most pointed issues (already curated by Claude)
//   • gsc.topDroppers — top page that lost the most clicks
//   • semrush.topMoversDown — biggest keyword drop (if any)
//   • actionItems.pending — outstanding count
//   • agentInsights — Tyr failed briefs + Loki high-value gaps surface as
//     direct call-to-action items
//
// Each item is one line, imperative voice, with an inline destination link
// when relevant. No paragraphs. No prose. The reader should be able to
// punch through this in 30 seconds.

interface PunchItem {
  emoji:    string
  headline: string
  subtext?: string
  href?:    string
  severity: 'critical' | 'warning' | 'info'
}

const PUNCH_STYLES: Record<PunchItem['severity'], string> = {
  critical: 'bg-red-950/40 border-red-700/50 text-red-100',
  warning:  'bg-amber-950/30 border-amber-700/40 text-amber-100',
  info:     'bg-blue-950/30 border-blue-800/40 text-blue-100',
}

function buildPunchItems(d: ReportData): PunchItem[] {
  const items: PunchItem[] = []

  // Top dropper page (GSC)
  if (d.gsc?.topDroppers && d.gsc.topDroppers.length > 0) {
    const top = d.gsc.topDroppers[0]
    if (top.delta < -10) {
      items.push({
        emoji:    '📉',
        severity: top.delta < -100 ? 'critical' : 'warning',
        headline: `Page lost ${Math.abs(top.delta).toLocaleString()} clicks: ${top.page.replace(/^https?:\/\/[^/]+/, '')}`,
        subtext:  `Now ${top.clicks.toLocaleString()}/wk. Diagnose with Heimdall.`,
        href:     '/gsc/ranking-drop',
      })
    }
  }

  // Tyr failed briefs (from agent_insights)
  if (d.agentInsights) {
    const insights = d.agentInsights as unknown as Record<string, unknown>
    const tyrFailed = Number((insights.tyr as Record<string, unknown> | undefined)?.failed_briefs ?? 0)
    if (tyrFailed > 0) {
      items.push({
        emoji:    '⚖️',
        severity: tyrFailed >= 3 ? 'warning' : 'info',
        headline: `Re-run regenerate for ${tyrFailed} Tyr-failed brief${tyrFailed > 1 ? 's' : ''}`,
        subtext:  'Approve regenerate actions in the queue.',
        href:     '/command-center',
      })
    }
    const lokiHighGaps = Number((insights.loki as Record<string, unknown> | undefined)?.high_value_gaps ?? 0)
    if (lokiHighGaps > 0) {
      items.push({
        emoji:    '🦊',
        severity: 'info',
        headline: `Approve ${lokiHighGaps} Loki gap${lokiHighGaps > 1 ? 's' : ''} ≥10K SV — auto-drafts via Bragi`,
        href:     '/command-center',
      })
    }
  }

  // Pending action items
  if (d.actionItems && d.actionItems.pending > 5) {
    items.push({
      emoji:    '✅',
      severity: d.actionItems.pending > 20 ? 'warning' : 'info',
      headline: `${d.actionItems.pending} action items still pending — assign or close`,
      subtext:  d.actionItems.completedThisWeek
        ? `Only ${d.actionItems.completedThisWeek} closed this week.`
        : 'No items closed this week.',
      href:     '/gsc/action-items',
    })
  }

  // Top SEMrush dropper
  if (d.semrush?.topMoversDown && d.semrush.topMoversDown.length > 0) {
    const top = d.semrush.topMoversDown[0]
    if (Math.abs(top.positionDiff) >= 5) {
      items.push({
        emoji:    '🔻',
        severity: 'warning',
        headline: `Keyword "${top.keyword}" dropped ${Math.abs(top.positionDiff)} positions to #${top.position}`,
        subtext:  `${top.volume.toLocaleString()} monthly searches at risk.`,
        href:     '/semrush/keywords',
      })
    }
  }

  // SEMrush instrumentation broken (zero across buckets)
  if (d.semrush && d.semrush.totalKeywords === 0) {
    items.push({
      emoji:    '⚠️',
      severity: 'critical',
      headline: 'SEMrush keyword tracking returning zero — fix instrumentation',
      subtext:  'No visibility into rank movements until this is fixed.',
      href:     '/command-center/health',
    })
  }

  // Revenue significant drop
  if (d.ga4 && d.ga4.revenuePct != null && d.ga4.revenuePct <= -8) {
    const totalRev = d.ga4.totalRevenue ?? 0
    items.push({
      emoji:    '💸',
      severity: d.ga4.revenuePct <= -15 ? 'critical' : 'warning',
      headline: `Revenue down ${Math.abs(d.ga4.revenuePct)}% week-over-week ($${(totalRev / 1000).toFixed(0)}K)`,
      subtext:  'Check AOV compression / category mix — alert finance.',
    })
  }

  // Pull AI-curated issues (first 3 punchiest) as fallback context
  if (items.length < 4 && d.aiIssues) {
    const bullets = d.aiIssues.split('\n')
      .map(l => l.replace(/^[\s•\-*]+/, '').replace(/^\*\*(.+?)\*\*[\s—–-]*/, '').trim())
      .filter(l => l.length > 20)
      .slice(0, 4 - items.length)
    for (const b of bullets) {
      items.push({
        emoji:    '⚠️',
        severity: 'warning',
        headline: b.length > 140 ? b.slice(0, 137) + '…' : b,
      })
    }
  }

  return items.slice(0, 6)
}

function ActionPunchList({ data }: { data: ReportData }) {
  const items = buildPunchItems(data)
  if (items.length === 0) {
    return (
      <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base">✅</span>
          <h3 className="text-sm font-semibold text-green-300 uppercase tracking-wider">All clear</h3>
        </div>
        <p className="text-sm text-gray-400">
          No critical action items surfaced for this week. Detail breakdowns below.
        </p>
      </div>
    )
  }
  return (
    <div className="bg-gradient-to-br from-gray-900 to-gray-950 border border-gray-700 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">🎯</span>
          <h3 className="text-sm font-semibold text-white uppercase tracking-wider">This week — actionables</h3>
          <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">{items.length}</span>
        </div>
        <p className="text-[10px] text-gray-600 uppercase tracking-wider">Read first · skim 30 sec</p>
      </div>
      <ol className="space-y-2">
        {items.map((it, i) => (
          <li key={i} className={`border rounded-lg px-3 py-2 ${PUNCH_STYLES[it.severity]}`}>
            <div className="flex items-start gap-3">
              <span className="text-base flex-shrink-0 leading-tight">{it.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium leading-snug">{it.headline}</p>
                {it.subtext && <p className="text-xs opacity-75 mt-0.5">{it.subtext}</p>}
              </div>
              {it.href && (
                <a
                  href={it.href}
                  className="text-[11px] font-semibold underline-offset-2 hover:underline whitespace-nowrap flex-shrink-0 mt-0.5"
                >
                  Go →
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WeeklyReportPage({ site = 'g2g' }: { site?: string }) {
  // Site-aware URL formatter — strips the site's origin from page URLs
  const fmtUrl = (url: string) => {
    const origins = [`https://www.${site}.com`, `https://${site}.com`]
    let result = url
    for (const o of origins) result = result.replace(o, '')
    // Handle offgamers specifically
    if (site === 'offgamers') {
      result = result.replace('https://www.offgamers.com', '').replace('https://offgamers.com', '')
    }
    return result || '/'
  }

  const [reports, setReports]         = useState<ReportSummary[]>([])
  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [report, setReport]           = useState<WeeklyReport | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingReport, setLoadingReport] = useState(false)
  const [generating, setGenerating]   = useState(false)
  const [error, setError]             = useState<string | null>(null)

  // Custom week picker state
  const defaultWeek = getDefaultWeek()
  const [customStart, setCustomStart] = useState(defaultWeek.start)
  const [customEnd,   setCustomEnd]   = useState(defaultWeek.end)
  const [showPicker,  setShowPicker]  = useState(false)

  // ── Load list of saved reports ──────────────────────────────────────────────
  const loadList = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch(`/api/reports/weekly?site=${site}`)
      if (res.ok) {
        const { reports: list } = await res.json()
        setReports(list ?? [])
        if (list?.length && !selectedId) setSelectedId(list[0].id)
      }
    } catch { /* silent */ }
    finally { setLoadingList(false) }
  }, []) // eslint-disable-line

  useEffect(() => { loadList() }, [loadList])

  // ── Load single report when selection changes ───────────────────────────────
  useEffect(() => {
    if (!selectedId) return
    setLoadingReport(true)
    setReport(null)
    fetch(`/api/reports/weekly?id=${selectedId}`)
      .then(r => r.json())
      .then(({ report: r }) => setReport(r))
      .catch(() => {})
      .finally(() => setLoadingReport(false))
  }, [selectedId])

  // ── Generate new report ─────────────────────────────────────────────────────
  async function generate() {
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/weekly', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, week_start: customStart, week_end: customEnd }),
      })
      const { report: r, error: e } = await res.json()
      if (e) { setError(e); return }
      setReports(prev => {
        const filtered = prev.filter(p => p.week_start !== r.week_start)
        return [r, ...filtered]
      })
      setSelectedId(r.id)
      setShowPicker(false)
      // Reset date inputs back to current week so old range doesn't persist
      const freshWeek = getDefaultWeek()
      setCustomStart(freshWeek.start)
      setCustomEnd(freshWeek.end)
    } catch (err: unknown) {
      setError(String(err))
    } finally {
      setGenerating(false)
    }
  }

  // ── Delete report ───────────────────────────────────────────────────────────
  async function deleteReport(id: string) {
    if (!confirm('Delete this report?')) return
    await fetch(`/api/reports/weekly?id=${id}`, { method: 'DELETE' })
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
          <h1 className="text-2xl font-bold text-white">📊 Weekly SEO Pulse</h1>
          <p className="text-gray-400 text-sm mt-1">
            Thu–Wed performance digest with AI-driven narrative and action plan.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {report && (
            <button
              onClick={() => window.print()}
              className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-2 rounded-lg transition flex items-center gap-1.5"
            >
              🖨️ Export PDF
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
              <div className="absolute right-0 top-full mt-2 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-4 w-72">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Week Range</p>
                <div className="space-y-2 mb-4">
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">Start (Thursday)</label>
                    <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 mb-1 block">End (Wednesday)</label>
                    <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-red-500" />
                  </div>
                </div>
                <button onClick={generate} disabled={generating}
                  className="w-full bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-xs font-semibold py-2 rounded-lg transition">
                  {generating ? '⏳ Generating…' : '🚀 Generate'}
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

      <div className="flex gap-6">

        {/* ── Sidebar: report list ── */}
        <div className="w-52 flex-shrink-0 print:hidden">
          {loadingList ? (
            <div className="flex justify-center py-8"><LottieLoader size={40} /></div>
          ) : reports.length === 0 ? (
            <div className="text-gray-600 text-xs text-center py-8">No reports yet.<br />Generate your first one!</div>
          ) : (
            <ul className="space-y-1">
              {reports.map(r => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelectedId(r.id)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition group ${
                      selectedId === r.id
                        ? 'bg-red-700/20 border border-red-700/40 text-white'
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    }`}
                  >
                    <p className="font-semibold">{weekLabel(r.week_start, r.week_end)}</p>
                    <p className="text-gray-500 text-[10px] mt-0.5">
                      Generated {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </p>
                  </button>
                  {selectedId === r.id && (
                    <button onClick={() => deleteReport(r.id)}
                      className="w-full text-center text-[10px] text-gray-600 hover:text-red-400 py-0.5 transition">
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── Main content ── */}
        <div className="flex-1 min-w-0">
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-20">
              <LottieLoader size={80} text={generating ? 'Generating your weekly report… (~30s)' : 'Loading…'} />
            </div>
          )}

          {!isLoading && !report && !loadingList && (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
              <p className="text-3xl mb-3">📊</p>
              <p className="text-white font-semibold mb-1">No report selected</p>
              <p className="text-gray-400 text-sm">Generate your first weekly report using the button above.</p>
            </div>
          )}

          {!isLoading && report && d && (
            <div className="space-y-6">

              {/* Print header */}
              <div className="hidden print:block mb-6">
                <h1 className="text-2xl font-bold">📊 Weekly SEO Pulse — G2G.com</h1>
                <p className="text-gray-500 text-sm">{weekLabel(d.weekStart, d.weekEnd)}</p>
              </div>

              {/* ── Week header ── */}
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">{weekLabel(d.weekStart, d.weekEnd)}</h2>
                  <p className="text-xs text-gray-500">
                    Generated {new Date(report.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
              </div>

              {/* ── KPI Cards — 2 rows of 3 ── */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {/* Row 1: Search */}
                <StatCard icon="🖱️" label="Clicks"
                  value={fmt(d.gsc.weekClicks)} pct={d.gsc.clicksPct}
                  sub={`prev ${fmt(d.gsc.prevWeekClicks)}`} />
                <StatCard icon="👁️" label="Impressions"
                  value={fmt(d.gsc.weekImpressions)} pct={d.gsc.impressionsPct}
                  sub={`avg pos ${d.gsc.avgPosition}`} />
                <StatCard icon="🎯" label="CTR"
                  value={d.gsc.weekCtr != null ? `${d.gsc.weekCtr}%` : '—'}
                  pct={d.gsc.ctrPct ?? null}
                  sub={d.gsc.prevWeekCtr != null ? `prev ${d.gsc.prevWeekCtr}%` : undefined} />
                {/* Row 2: Revenue */}
                {d.ga4 ? (
                  <>
                    <StatCard icon="📈" label="Organic Sessions"
                      value={fmt(d.ga4.weekSessions)} pct={d.ga4.sessionsPct}
                      sub={`prev ${fmt(d.ga4.prevWeekSessions)}`} />
                    <StatCard icon="💰" label="Revenue"
                      value={d.ga4.totalRevenue != null ? fmtUsd(d.ga4.totalRevenue) : '—'}
                      pct={d.ga4.revenuePct ?? null}
                      sub={d.ga4.prevRevenue != null ? `prev ${fmtUsd(d.ga4.prevRevenue)}` : undefined} />
                    <StatCard icon="🛒" label="Purchases"
                      value={d.ga4.totalPurchases != null ? fmt(d.ga4.totalPurchases) : '—'}
                      pct={d.ga4.purchasesPct ?? null}
                      sub={d.ga4.prevPurchases != null ? `prev ${fmt(d.ga4.prevPurchases)}` : undefined} />
                  </>
                ) : (
                  <StatCard icon="📈" label="Organic Sessions" value="—" sub={d.ga4Error ?? 'GA4 not connected'} />
                )}
              </div>

              {/* ── Domain Authority (SEMrush) ── */}
              {d.domainAuthority && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">🔰 Domain Strength (SEMrush)</h3>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Organic Keywords</p>
                      <p className="text-xl font-bold text-white">{fmt(d.domainAuthority.organicKeywords)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Est. Monthly Traffic</p>
                      <p className="text-xl font-bold text-white">{fmt(d.domainAuthority.organicTraffic)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Est. Traffic Value</p>
                      <p className="text-xl font-bold text-white">{fmtUsd(d.domainAuthority.organicCost)}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Action Punch List (TOP — read first, 30-sec skim) ── */}
              <ActionPunchList data={d} />

              {/* ── Traffic + Keywords ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* GSC movers */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">📉 Traffic Movers</h3>
                  {d.gsc.topGainers.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-green-400 uppercase tracking-wider mb-2">Gainers</p>
                      <ul className="space-y-2 mb-4">
                        {d.gsc.topGainers.map(g => (
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
                        {d.gsc.topDroppers.map(g => (
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
                    <p className="text-xs text-gray-500">No GSC data for this week yet.</p>
                  )}
                </div>

                {/* Keyword movers */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-white">🎯 Keyword Movement</h3>
                    <div className="flex gap-3 text-xs text-gray-500">
                      <span>Top 3: <strong className="text-white">{d.semrush.top3}</strong></span>
                      <span>Top 10: <strong className="text-white">{d.semrush.top10}</strong></span>
                    </div>
                  </div>
                  {d.semrush.topMoversUp.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-green-400 uppercase tracking-wider mb-2">Rising</p>
                      <ul className="space-y-1.5 mb-4">
                        {d.semrush.topMoversUp.slice(0, 5).map(k => (
                          <li key={k.keyword} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-300 truncate">{k.keyword}</p>
                              <p className="text-[10px] text-gray-500">pos {k.position} · {fmt(k.volume)} vol</p>
                            </div>
                            <span className="text-xs font-semibold text-green-400 flex-shrink-0">↑{k.positionDiff}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {d.semrush.topMoversDown.length > 0 && (
                    <>
                      <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wider mb-2">Falling</p>
                      <ul className="space-y-1.5">
                        {d.semrush.topMoversDown.slice(0, 5).map(k => (
                          <li key={k.keyword} className="flex items-center gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-300 truncate">{k.keyword}</p>
                              <p className="text-[10px] text-gray-500">pos {k.position} · {fmt(k.volume)} vol</p>
                            </div>
                            <span className="text-xs font-semibold text-red-400 flex-shrink-0">↓{Math.abs(k.positionDiff)}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {d.semrush.totalKeywords === 0 && (
                    <p className="text-xs text-gray-500">No SEMrush data available.</p>
                  )}
                </div>
              </div>

              {/* ── GA4 top pages ── */}
              {d.ga4 && d.ga4.topPages.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-4">📄 Top Organic Category Pages (GA4)</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-800">
                          <th className="text-left pb-2 text-gray-500 font-semibold uppercase tracking-wider">Page</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-20">Sessions</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-24">Purchases</th>
                          <th className="text-right pb-2 text-gray-500 font-semibold uppercase tracking-wider w-24">Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const maxSessions = Math.max(...d.ga4!.topPages.map(p => p.sessions), 1)
                          return d.ga4!.topPages.map(p => (
                            <tr key={p.pagePath} className="border-b border-gray-800/50 last:border-0">
                              <td className="py-2 pr-3">
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-gray-300 truncate max-w-xs">{p.pagePath}</p>
                                    <div className="h-1 bg-gray-800 rounded-full mt-1 overflow-hidden w-full">
                                      <div className="h-full bg-blue-600 rounded-full" style={{ width: `${Math.round((p.sessions / maxSessions) * 100)}%` }} />
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="py-2 text-right text-gray-300 font-medium">{fmt(p.sessions)}</td>
                              <td className="py-2 text-right">
                                <span className={(p.purchases ?? 0) > 0 ? 'text-green-400 font-medium' : 'text-gray-600'}>
                                  {(p.purchases ?? 0) > 0 ? fmt(p.purchases!) : '—'}
                                </span>
                              </td>
                              <td className="py-2 text-right">
                                <span className={(p.revenue ?? 0) > 0 ? 'text-amber-400 font-medium' : 'text-gray-600'}>
                                  {(p.revenue ?? 0) > 0 ? fmtUsd(p.revenue!) : '—'}
                                </span>
                              </td>
                            </tr>
                          ))
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Action Items ── */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-4">✅ Action Items</h3>
                <div className="grid grid-cols-3 gap-4 mb-5">
                  <div className="bg-gray-800 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-white">{d.actionItems.assignedThisWeek}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Assigned this week</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-green-400">{d.actionItems.completedThisWeek}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Completed this week</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3 text-center">
                    <p className="text-xl font-bold text-yellow-400">{d.actionItems.pending + d.actionItems.inProgress}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">Still open</p>
                  </div>
                </div>
                {(d.actionItems.byAssignee ?? []).filter(a => a.email !== '(unassigned)').length > 0 && (
                  <>
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">By Team Member</p>
                    <div className="space-y-2">
                      {(d.actionItems.byAssignee ?? []).filter(a => a.email !== '(unassigned)').map(a => {
                        const completionRate = a.assigned > 0 ? Math.round((a.completed / a.assigned) * 100) : 0
                        return (
                          <div key={a.email} className="flex items-center gap-3">
                            <div className="w-32 flex-shrink-0">
                              <p className="text-xs text-gray-300 truncate">{a.email.split('@')[0]}</p>
                            </div>
                            <Bar value={a.completed} max={a.assigned} color="bg-green-600" />
                            <p className="text-xs text-gray-400 w-24 text-right flex-shrink-0">
                              {a.completed}/{a.assigned} · {completionRate}%
                            </p>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>

              {/* ── Competitive SoV ── */}
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-white">👁️ Share of Voice</h3>
                  <div className="flex items-center gap-2">
                    {(d.competitive.sovKeywordCount ?? 0) > 0 && (
                      <span className="text-xs text-gray-500">{d.competitive.sovKeywordCount} tracked kws</span>
                    )}
                    {d.competitive.sovEstimated && (
                      <span className="text-[10px] text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                        estimated via SEMrush
                      </span>
                    )}
                  </div>
                </div>

                {(d.competitive.sovTable ?? []).length > 0 ? (
                  <div className="space-y-2.5">
                    {(d.competitive.sovTable ?? []).map(row => {
                      const isG2G = row.domain === 'g2g.com'
                      const maxSov = (d.competitive.sovTable ?? [])[0]?.sov ?? 1
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
                          {!d.competitive.sovEstimated && (
                            <span className="text-[10px] text-gray-600 w-16 text-right flex-shrink-0">
                              {row.keywords} kws
                            </span>
                          )}
                        </div>
                      )
                    })}
                    {d.competitive.sovEstimated && (
                      <p className="text-[10px] text-gray-600 mt-2">
                        Estimated from SEMrush organic traffic data. For SERP-based SoV,{' '}
                        <a href="/competitive/serp-tracker" className="text-red-400 hover:text-red-300">run SERP Tracker</a>.
                      </p>
                    )}
                  </div>
                ) : (
                  <div>
                    {(d.competitive.trackedCompetitors ?? []).length > 0 ? (
                      <div>
                        <div className="flex flex-wrap gap-2 mb-3">
                          {(d.competitive.trackedCompetitors ?? []).map(c => (
                            <span key={c.domain} className="text-xs bg-gray-800 text-gray-300 px-3 py-1.5 rounded-full flex items-center gap-1.5">
                              <img src={`https://www.google.com/s2/favicons?domain=${c.domain}&sz=16`} alt="" className="w-3 h-3" />
                              {c.name || c.domain}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-500">
                          No competitor data available. Run{' '}
                          <a href="/competitive/serp-tracker" className="text-red-400 hover:text-red-300">SERP Tracker</a>{' '}
                          to start tracking Share of Voice.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-gray-500">
                        No competitors tracked yet.{' '}
                        <a href="/competitive/competitors" className="text-red-400 hover:text-red-300">Add competitors →</a>
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ─────────────────────────────────────────────────────────
                  DETAILED ANALYSIS — moved BELOW the punch list at top.
                  Read this section if you need full context, narrative,
                  per-issue breakdown, or want the management/team plan.
                  ───────────────────────────────────────────────────────── */}
              <div className="border-t border-gray-800 pt-6 mt-2">
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-base">📖</span>
                  <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Full analysis</h2>
                  <span className="text-[10px] text-gray-600">— skip if the punch list above is enough</span>
                </div>
              </div>

              {/* ── AI Narrative (moved from top) ── */}
              {report.ai_narrative && (
                <div className="bg-gradient-to-br from-gray-900 to-gray-900/80 border border-gray-700 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-base">✨</span>
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider">AI Analysis</h3>
                    <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Claude</span>
                  </div>
                  <div className="space-y-3">
                    {report.ai_narrative.split('\n\n').map((para, i) => (
                      <p key={i} className="text-sm text-gray-300 leading-relaxed">{para}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* ── Issues & Shortcomings (moved from top) ── */}
              {d.aiIssues && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-base">⚠️</span>
                    <h3 className="text-sm font-semibold text-amber-300 uppercase tracking-wider">Issues & Shortcomings</h3>
                  </div>
                  <IssuesList raw={d.aiIssues} />
                </div>
              )}

              {/* ── Agent Activity (auto-hidden if no activity) ── */}
              <AgentActivitySummary insights={d.agentInsights ?? null} />

              {/* ── Management Brief + Team Plan ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                {/* Management Brief — only shown for new reports with split plans */}
                {d.aiManagementPlan && (
                  <div className="bg-gradient-to-br from-blue-950/30 to-gray-900 border border-blue-800/30 rounded-xl p-6">
                    <div className="flex items-center gap-2 mb-5">
                      <span className="text-base">📋</span>
                      <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Management Brief</h3>
                      <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Strategic</span>
                    </div>
                    <ActionPlan raw={d.aiManagementPlan} />
                  </div>
                )}

                {/* Internal Team Plan — new reports use aiTeamPlan, old reports fall back to ai_action_plan */}
                {(d.aiTeamPlan || report.ai_action_plan) && (
                  <div className={`bg-gradient-to-br from-red-950/30 to-gray-900 border border-red-800/30 rounded-xl p-6 ${!d.aiManagementPlan ? 'md:col-span-2' : ''}`}>
                    <div className="flex items-center gap-2 mb-5">
                      <span className="text-base">⚡</span>
                      <h3 className="text-sm font-semibold text-white uppercase tracking-wider">
                        {d.aiManagementPlan ? 'Internal Team Plan' : 'Weekly Action Plan'}
                      </h3>
                      <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">
                        {d.aiManagementPlan ? 'Tactical' : 'AI-recommended'}
                      </span>
                    </div>
                    <ActionPlan raw={d.aiTeamPlan ?? report.ai_action_plan} />
                  </div>
                )}

              </div>

            </div>
          )}
        </div>
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          /* Preserve all background colors & gradients */
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color-adjust: exact !important;
          }

          /* Keep dark theme */
          html, body {
            background: #030712 !important;
            color: #f9fafb !important;
            font-size: 11px;
          }

          /* Remove page margins */
          @page {
            margin: 16mm 12mm;
            size: A4 portrait;
          }

          /* Hide nav & sidebar */
          .print\\:hidden { display: none !important; }
          .print\\:block  { display: block !important; }
          aside, nav     { display: none !important; }

          /* Main layout: collapse sidebar, full width */
          .flex.gap-6 { display: block !important; }

          /* Cards stay on one page where possible */
          .rounded-xl, .rounded-2xl, section { page-break-inside: avoid; break-inside: avoid; }
          tr { page-break-inside: avoid; break-inside: avoid; }

          /* Slightly tighter spacing for print */
          .space-y-6 > * + * { margin-top: 14px !important; }
          .p-5 { padding: 14px !important; }
          .p-6 { padding: 16px !important; }

          /* Ensure grid columns work in print */
          .grid-cols-2, .md\\:grid-cols-2 { grid-template-columns: 1fr 1fr !important; }
          .md\\:grid-cols-3               { grid-template-columns: 1fr 1fr 1fr !important; }
          .md\\:grid-cols-4               { grid-template-columns: 1fr 1fr 1fr 1fr !important; }

          /* Prevent stat cards from being too large */
          .text-3xl { font-size: 1.5rem  !important; }
          .text-2xl { font-size: 1.25rem !important; }

          /* Links — don't show URL in print */
          a[href]:after { content: '' !important; }
        }
      `}</style>
    </div>
  )
}
