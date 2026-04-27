'use client'

import { useEffect, useState } from 'react'

interface HealthData {
  overall: 'ok' | 'warning' | 'critical'
  issues: Array<{ severity: 'critical' | 'warning'; message: string }>
  connections: Array<{ name: string; ok: boolean; detail: string }>
  crons: Array<{ name: string; lastRun: string | null; schedule: string; ok: boolean; note: string }>
  agents24: Array<{ agent_key: string; runs: number; success: number; partial: number; error: number }>
  agentSummary: { totalRuns: number; totalSuccess: number; totalPartial: number; totalError: number; actionsQueued: number; actionsResolved: number }
  dataFreshness: Array<{ table: string; latest: string | null; ageHours: number | null; expectedHours: number }>
  recentErrors: Array<{ runId: string; agent_key: string; status: string; when: string; summary: string | null; error: string | null }>
  budget: { mtdSpendUsd: number; projectedSpendUsd: number; monthlyBudgetUsd: number | null; pctUsed: number | null; pctProjected: number | null; daysElapsed: number; daysInMonth: number }
  checkedAt: string
}

const AGENT_NAMES: Record<string, { name: string; emoji: string }> = {
  heimdall: { name: 'Heimdall', emoji: '👁️' },
  odin:     { name: 'Odin',     emoji: '🔮' },
  loki:     { name: 'Loki',     emoji: '🕵️' },
  bragi:    { name: 'Bragi',    emoji: '✍️' },
  hermod:   { name: 'Hermod',   emoji: '🤝' },
  tyr:      { name: 'Tyr',      emoji: '⚖️' },
  vor:      { name: 'Vor',      emoji: '🦉' },
  saga:     { name: 'Saga',     emoji: '📜' },
}

function formatAge(hours: number | null): string {
  if (hours === null) return 'never'
  if (hours < 1)  return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const fetchHealth = async () => {
    setLoading(true)
    setErr(null)
    try {
      const res = await fetch('/api/system/health')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHealth()
    const t = setInterval(fetchHealth, 60_000)
    return () => clearInterval(t)
  }, [])

  if (loading && !data) return <div className="p-8 text-gray-400">Loading system health…</div>
  if (err && !data) return <div className="p-8 text-red-400">Failed to load: {err}</div>
  if (!data) return null

  const overallColor =
    data.overall === 'ok'       ? 'green' :
    data.overall === 'warning'  ? 'amber' : 'red'

  const overallLabel =
    data.overall === 'ok'       ? '✅ All systems operational' :
    data.overall === 'warning'  ? '⚠️ Warnings — review below' : '🔴 Critical issues need attention'

  const overallBg: Record<typeof overallColor, string> = {
    green: 'bg-green-950/30 border-green-700/40',
    amber: 'bg-amber-950/30 border-amber-700/40',
    red:   'bg-red-950/30 border-red-700/40',
  }
  const overallText: Record<typeof overallColor, string> = {
    green: 'text-green-300',
    amber: 'text-amber-300',
    red:   'text-red-300',
  }

  return (
    <div className="p-8 max-w-7xl">
      <header className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">🩺 System Health</h1>
          <p className="text-gray-400 mt-1 text-sm">
            One-shot check of every moving part · Last refreshed {new Date(data.checkedAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : '🔄 Refresh'}
        </button>
      </header>

      {/* Overall banner */}
      <div className={`mb-6 rounded-xl border ${overallBg[overallColor]} p-5`}>
        <p className={`text-lg font-semibold ${overallText[overallColor]}`}>{overallLabel}</p>
        {data.issues.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {data.issues.map((i, idx) => (
              <li key={idx} className={i.severity === 'critical' ? 'text-red-300' : 'text-amber-300'}>
                {i.severity === 'critical' ? '🔴' : '⚠️'} {i.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 2x2 grid: connections | crons // agents | data freshness */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">

        {/* Connections */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">🔌 Connections</h2>
          <ul className="space-y-2">
            {data.connections.map(c => (
              <li key={c.name} className="flex items-start gap-2">
                <span className={c.ok ? 'text-green-400' : 'text-red-400'}>{c.ok ? '✓' : '✗'}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium">{c.name}</p>
                  <p className="text-gray-500 text-xs truncate">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Crons */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">⏰ Cron jobs</h2>
          <ul className="space-y-2.5">
            {data.crons.map(c => (
              <li key={c.name} className="flex items-start gap-2">
                <span className={c.ok ? 'text-green-400' : 'text-amber-400'}>{c.ok ? '✓' : '⚠'}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-white text-sm font-mono">{c.name}</p>
                    <p className="text-xs text-gray-500">{formatTime(c.lastRun)}</p>
                  </div>
                  <p className="text-gray-500 text-xs">{c.schedule}{c.note ? ` · ${c.note}` : ''}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Agents 24h */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-1">🤖 Agent activity (24h)</h2>
          <p className="text-gray-500 text-xs mb-3">
            {data.agentSummary.totalRuns} runs · {data.agentSummary.totalSuccess} success · {data.agentSummary.totalPartial} partial · {data.agentSummary.totalError} error · {data.agentSummary.actionsQueued} pending actions
          </p>
          <table className="w-full text-xs">
            <thead className="text-gray-500 uppercase tracking-wider border-b border-gray-800">
              <tr>
                <th className="text-left  py-1.5">Agent</th>
                <th className="text-right py-1.5">Runs</th>
                <th className="text-right py-1.5">✓</th>
                <th className="text-right py-1.5">⚠</th>
                <th className="text-right py-1.5">✗</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {data.agents24.map(a => {
                const meta = AGENT_NAMES[a.agent_key] ?? { name: a.agent_key, emoji: '🤖' }
                return (
                  <tr key={a.agent_key} className={a.runs === 0 ? 'opacity-40' : ''}>
                    <td className="py-1 text-white">{meta.emoji} {meta.name}</td>
                    <td className="py-1 text-right text-gray-300">{a.runs || '—'}</td>
                    <td className="py-1 text-right text-green-400">{a.success || '—'}</td>
                    <td className="py-1 text-right text-amber-400">{a.partial || '—'}</td>
                    <td className="py-1 text-right text-red-400">{a.error || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        {/* Data freshness */}
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">📊 Data freshness</h2>
          <ul className="space-y-2.5">
            {data.dataFreshness.map(d => {
              const stale = d.ageHours !== null && d.ageHours > d.expectedHours
              return (
                <li key={d.table} className="flex items-start gap-2">
                  <span className={d.ageHours === null ? 'text-gray-600' : stale ? 'text-amber-400' : 'text-green-400'}>
                    {d.ageHours === null ? '○' : stale ? '⚠' : '✓'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-white text-sm font-mono">{d.table}</p>
                      <p className="text-xs text-gray-400">{formatAge(d.ageHours)}</p>
                    </div>
                    <p className="text-gray-500 text-xs">Expected refresh ≤ {Math.round(d.expectedHours / 24)}d</p>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      </div>

      {/* Budget tracker */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">💰 Anthropic budget</h2>
          <p className="text-xs text-gray-500">Day {data.budget.daysElapsed} of {data.budget.daysInMonth}</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Stat label="Spent MTD"  value={`$${data.budget.mtdSpendUsd.toFixed(2)}`} color="text-purple-400" />
          <Stat label="Projected"  value={`$${data.budget.projectedSpendUsd.toFixed(2)}`}
            color={data.budget.pctProjected !== null && data.budget.pctProjected > 100 ? 'text-red-400' : data.budget.pctProjected !== null && data.budget.pctProjected > 80 ? 'text-amber-400' : 'text-blue-400'} />
          <Stat label="Budget"     value={data.budget.monthlyBudgetUsd ? `$${data.budget.monthlyBudgetUsd.toFixed(2)}` : '—'}
            sub={data.budget.monthlyBudgetUsd ? '' : 'Set ANTHROPIC_MONTHLY_BUDGET_USD env'} />
          <Stat label="Used"       value={data.budget.pctUsed !== null ? `${data.budget.pctUsed}%` : '—'}
            color={data.budget.pctUsed !== null && data.budget.pctUsed > 100 ? 'text-red-400' : 'text-white'} />
        </div>
        {data.budget.monthlyBudgetUsd && data.budget.pctUsed !== null && (
          <div>
            <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full ${
                  data.budget.pctUsed > 100 ? 'bg-red-500' :
                  data.budget.pctUsed > 80  ? 'bg-amber-500' : 'bg-purple-500'
                }`}
                style={{ width: `${Math.min(data.budget.pctUsed, 100)}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-2">
              At current pace, end-of-month spend will be ${data.budget.projectedSpendUsd.toFixed(2)} ({data.budget.pctProjected}% of budget)
            </p>
          </div>
        )}
      </section>

      {/* Recent errors */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-3">🚨 Recent errors / partials (7d)</h2>
        {data.recentErrors.length === 0 ? (
          <p className="text-gray-500 text-sm">No errors in the last 7 days. ✓</p>
        ) : (
          <ul className="space-y-2">
            {data.recentErrors.map(e => {
              const meta = AGENT_NAMES[e.agent_key] ?? { name: e.agent_key, emoji: '🤖' }
              const color = e.status === 'error' ? 'text-red-400' : 'text-amber-400'
              return (
                <li key={e.runId} className="border-l-2 border-gray-800 pl-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className={`text-sm font-medium ${color}`}>
                      {meta.emoji} {meta.name} · {e.status}
                    </p>
                    <p className="text-xs text-gray-500">{formatTime(e.when)}</p>
                  </div>
                  {e.summary && <p className="text-gray-400 text-xs mt-0.5 line-clamp-2">{e.summary}</p>}
                  {e.error && <p className="text-red-400/80 text-xs mt-0.5 font-mono line-clamp-2">{e.error}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
      <p className={`text-xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
      {sub && <p className="text-gray-600 text-[11px] mt-1">{sub}</p>}
    </div>
  )
}
