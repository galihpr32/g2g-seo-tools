'use client'

import { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend } from 'recharts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentStats {
  key:           string
  totalRuns:     number
  successRuns:   number
  errorRuns:     number
  successRate:   number
  totalFindings: number
  totalQueued:   number
  totalApproved: number
  totalRejected: number
  totalPending:  number
  approvalRate:  number
  avgRunMs:      number | null
  lastRunAt:     string | null
  runsByDay:     { date: string; runs: number; findings: number }[]
  actionsByDay:  { date: string; queued: number; approved: number }[]
}

interface PerformanceData {
  stats:   Record<string, AgentStats>
  overall: { totalRuns: number; totalFindings: number; totalQueued: number; totalApproved: number; totalPending: number }
  days:    number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; emoji: string; color: string }> = {
  'heimdall':      { label: 'Heimdall',      emoji: '🔍', color: '#3b82f6' },
  'odin':   { label: 'Odin',   emoji: '📈', color: '#22c55e' },
  'loki': { label: 'Loki', emoji: '🕵️', color: '#a855f7' },
  'bragi': { label: 'Bragi', emoji: '✍️', color: '#f59e0b' },
  'hermod':  { label: 'Hermod',  emoji: '🤝', color: '#ef4444' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMs(ms: number | null): string {
  if (!ms) return '—'
  if (ms < 1000)  return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ── Stat Card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color = 'text-white' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-1">{sub}</p>}
    </div>
  )
}

// ── Agent Row ─────────────────────────────────────────────────────────────────
function AgentRow({ s }: { s: AgentStats }) {
  const meta = AGENT_META[s.key] ?? { label: s.key, emoji: '🤖', color: '#6b7280' }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">{meta.emoji}</span>
          <h3 className="text-white font-semibold">{meta.label}</h3>
          {s.totalRuns === 0 && (
            <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded">No runs yet</span>
          )}
        </div>
        <span className="text-xs text-gray-500">{fmtDate(s.lastRunAt)}</span>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <p className={`text-xl font-bold ${s.successRate >= 80 ? 'text-green-400' : s.successRate >= 50 ? 'text-yellow-400' : s.totalRuns === 0 ? 'text-gray-600' : 'text-red-400'}`}>
            {s.totalRuns === 0 ? '—' : `${s.successRate}%`}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">Success rate</p>
          <p className="text-[10px] text-gray-600">{s.successRuns}/{s.totalRuns} runs</p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <p className="text-xl font-bold text-white">{s.totalFindings > 0 ? s.totalFindings.toLocaleString() : '—'}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">Findings</p>
          <p className="text-[10px] text-gray-600">{s.totalQueued} queued</p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <p className={`text-xl font-bold ${s.approvalRate >= 70 ? 'text-green-400' : s.approvalRate >= 40 ? 'text-yellow-400' : s.totalApproved + s.totalRejected === 0 ? 'text-gray-600' : 'text-red-400'}`}>
            {s.totalApproved + s.totalRejected === 0 ? '—' : `${s.approvalRate}%`}
          </p>
          <p className="text-[10px] text-gray-500 mt-0.5">Approval rate</p>
          <p className="text-[10px] text-gray-600">{s.totalApproved} approved · {s.totalRejected} rejected</p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3 text-center">
          <p className="text-xl font-bold text-white">{fmtMs(s.avgRunMs)}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">Avg run time</p>
          <p className="text-[10px] text-gray-600">{s.totalPending > 0 ? `${s.totalPending} pending` : 'no pending'}</p>
        </div>
      </div>

      {/* Actions by day mini chart */}
      {s.actionsByDay.length > 1 && (
        <div className="h-20">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={s.actionsByDay} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
                labelFormatter={(v) => v}
              />
              <Bar dataKey="queued"   name="Queued"   fill={meta.color} opacity={0.4} radius={[2, 2, 0, 0]} />
              <Bar dataKey="approved" name="Approved" fill={meta.color} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AgentPerformancePage() {
  const [data,    setData]    = useState<PerformanceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [days,    setDays]    = useState(30)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/agents/performance?days=${days}`)
      .then(r => r.json())
      .then(d => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [days])

  // Build combined "all agents" actions by day chart
  const combinedByDay = (() => {
    if (!data) return []
    const map = new Map<string, Record<string, number>>()
    for (const [key, s] of Object.entries(data.stats)) {
      for (const { date, queued } of s.actionsByDay) {
        if (!map.has(date)) map.set(date, {})
        map.get(date)![key] = queued
      }
    }
    return [...map.entries()]
      .map(([date, vals]) => ({ date, ...vals }))
      .sort((a, b) => a.date.localeCompare(b.date))
  })()

  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-3">
          <a href="/command-center" className="hover:text-white transition">🧠 Command Center</a>
          <span>/</span>
          <span className="text-gray-300">Performance</span>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">📊 Agent Performance</h1>
            <p className="text-gray-400 text-sm mt-1">Track how agents are doing — runs, findings, and approval rates.</p>
          </div>
          {/* Period selector */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {([7, 30, 90] as const).map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs transition ${days === d ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm text-center py-16">Loading…</div>
      ) : !data ? (
        <div className="text-red-400 text-sm text-center py-16">Failed to load performance data.</div>
      ) : (
        <>
          {/* Overall stats */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-8">
            <StatCard label="Total runs"     value={data.overall.totalRuns}     sub={`last ${days} days`} />
            <StatCard label="Total findings" value={data.overall.totalFindings.toLocaleString()} color="text-blue-400" />
            <StatCard label="Actions queued" value={data.overall.totalQueued}   color="text-purple-400" />
            <StatCard label="Approved"       value={data.overall.totalApproved} color="text-green-400" />
            <StatCard label="Pending review" value={data.overall.totalPending}  color={data.overall.totalPending > 0 ? 'text-yellow-400' : 'text-gray-500'} />
          </div>

          {/* Combined actions by day chart */}
          {combinedByDay.length > 1 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
              <h2 className="text-white font-semibold text-sm mb-4">Actions queued per day — all agents</h2>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={combinedByDay} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }}
                      tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {Object.entries(AGENT_META).map(([key, meta]) => (
                      <Bar key={key} dataKey={key} name={meta.label} stackId="a" fill={meta.color} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Per-agent cards */}
          <div className="space-y-4">
            {Object.values(data.stats).map(s => (
              <AgentRow key={s.key} s={s} />
            ))}
          </div>

          {/* Run success trend */}
          {Object.values(data.stats).some(s => s.runsByDay.length > 1) && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mt-8">
              <h2 className="text-white font-semibold text-sm mb-4">Findings per day — all agents</h2>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" type="category" allowDuplicatedCategory={false}
                      tick={{ fill: '#6b7280', fontSize: 10 }}
                      tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8, fontSize: 11 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {Object.values(data.stats).filter(s => s.runsByDay.length > 0).map(s => {
                      const meta = AGENT_META[s.key]
                      return (
                        <Line
                          key={s.key}
                          data={s.runsByDay}
                          type="monotone"
                          dataKey="findings"
                          name={meta?.label ?? s.key}
                          stroke={meta?.color ?? '#6b7280'}
                          strokeWidth={2}
                          dot={false}
                        />
                      )
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
