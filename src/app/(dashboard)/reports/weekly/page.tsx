'use client'

import { useState, useEffect, useCallback } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

interface GscData {
  weekClicks: number
  prevWeekClicks: number
  clicksPct: number | null
  weekImpressions: number
  prevWeekImpressions: number
  impressionsPct: number | null
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
  topPages: { pagePath: string; sessions: number }[]
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
  byAssignee: { email: string; assigned: number; completed: number; inProgress: number }[]
}

interface ReportData {
  weekStart: string
  weekEnd: string
  gsc: GscData
  ga4: Ga4Data | null
  semrush: SemrushData
  actionItems: ActionItemsData
  competitive: { trackedCompetitors: { domain: string; name?: string }[] }
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
function pctBadge(pct: number | null) {
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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function WeeklyReportPage() {
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
      const res = await fetch('/api/reports/weekly')
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
        body: JSON.stringify({ week_start: customStart, week_end: customEnd }),
      })
      const { report: r, error: e } = await res.json()
      if (e) { setError(e); return }
      setReports(prev => {
        const filtered = prev.filter(p => p.week_start !== r.week_start)
        return [r, ...filtered]
      })
      setSelectedId(r.id)
      setShowPicker(false)
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

              {/* ── KPI Cards ── */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon="🖱️" label="Clicks"
                  value={fmt(d.gsc.weekClicks)} pct={d.gsc.clicksPct}
                  sub={`prev ${fmt(d.gsc.prevWeekClicks)}`} />
                <StatCard icon="👁️" label="Impressions"
                  value={fmt(d.gsc.weekImpressions)} pct={d.gsc.impressionsPct}
                  sub={`pos ${d.gsc.avgPosition}`} />
                {d.ga4 ? (
                  <StatCard icon="📈" label="Organic Sessions"
                    value={fmt(d.ga4.weekSessions)} pct={d.ga4.sessionsPct}
                    sub={`prev ${fmt(d.ga4.prevWeekSessions)}`} />
                ) : (
                  <StatCard icon="📈" label="Organic Sessions" value="—" sub="GA4 not connected" />
                )}
                <StatCard icon="✅" label="Tasks Done"
                  value={String(d.actionItems.completedThisWeek)}
                  sub={`${d.actionItems.inProgress} in progress · ${d.actionItems.pending} pending`} />
              </div>

              {/* ── AI Narrative ── */}
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
                  <h3 className="text-sm font-semibold text-white mb-4">📄 Top Organic Pages (GA4)</h3>
                  <div className="space-y-2">
                    {(() => {
                      const maxSessions = Math.max(...d.ga4!.topPages.map(p => p.sessions))
                      return d.ga4!.topPages.map(p => (
                        <div key={p.pagePath} className="flex items-center gap-3">
                          <p className="text-xs text-gray-300 truncate w-64">{p.pagePath}</p>
                          <Bar value={p.sessions} max={maxSessions} color="bg-blue-600" />
                          <p className="text-xs text-gray-400 w-16 text-right flex-shrink-0">{fmt(p.sessions)}</p>
                        </div>
                      ))
                    })()}
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
                {d.actionItems.byAssignee.filter(a => a.email !== '(unassigned)').length > 0 && (
                  <>
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-3">By Team Member</p>
                    <div className="space-y-2">
                      {d.actionItems.byAssignee.filter(a => a.email !== '(unassigned)').map(a => {
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

              {/* ── Competitive ── */}
              {d.competitive.trackedCompetitors.length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-white mb-3">👁️ Tracked Competitors</h3>
                  <div className="flex flex-wrap gap-2">
                    {d.competitive.trackedCompetitors.map(c => (
                      <span key={c.domain} className="text-xs bg-gray-800 text-gray-300 px-3 py-1.5 rounded-full flex items-center gap-1.5">
                        <img src={`https://www.google.com/s2/favicons?domain=${c.domain}&sz=16`} alt="" className="w-3 h-3" />
                        {c.name || c.domain}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-gray-600 mt-2">
                    Run <a href="/competitive/serp-tracker" className="text-red-400 hover:text-red-300">SERP Tracker</a> for full Share of Voice breakdown.
                  </p>
                </div>
              )}

              {/* ── AI Action Plan ── */}
              {report.ai_action_plan && (
                <div className="bg-gradient-to-br from-red-950/30 to-gray-900 border border-red-800/30 rounded-xl p-6">
                  <div className="flex items-center gap-2 mb-5">
                    <span className="text-base">🎯</span>
                    <h3 className="text-sm font-semibold text-white uppercase tracking-wider">Weekly Action Plan</h3>
                    <span className="text-[10px] text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">AI-recommended</span>
                  </div>
                  <ActionPlan raw={report.ai_action_plan} />
                </div>
              )}

            </div>
          )}
        </div>
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body { background: white; color: black; }
          .print\\:hidden { display: none !important; }
          .print\\:block  { display: block !important; }
          aside { display: none !important; }
        }
      `}</style>
    </div>
  )
}
