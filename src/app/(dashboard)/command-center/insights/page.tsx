'use client'

import { useEffect, useState } from 'react'

interface ApprovalStats {
  total: number; approved: number; rejected: number; pending: number; executed: number
}
interface TopicStats {
  id: string; topic: string; status: string; lastActivity: string | null
  total: number; published: number; coveragePct: number
}
interface PendingMeta {
  id: string; agent_key: string; action_type: string; title: string
  description: string | null; priority: string; created_at: string
}
interface InsightsResponse {
  windowDays: number
  approvalByAgent: Record<string, ApprovalStats>
  tyr: { reviewedCount: number; meanScore: number; medianScore: number; promoted: number; borderline: number; failed: number }
  topics: TopicStats[]
  pendingMeta: PendingMeta[]
}

const AGENT_LABEL: Record<string, string> = {
  heimdall: 'Heimdall', odin: 'Odin', loki: 'Loki', bragi: 'Bragi',
  hermod: 'Hermod', tyr: 'Tyr', vor: 'Vor', saga: 'Saga',
}

const ACTION_TYPE_LABEL: Record<string, string> = {
  tune_config:       '⚙️ Config tuning',
  coverage_review:   '📊 Coverage review',
  archive_cluster:   '📦 Archive cluster',
  create_topic_map:  '🌱 New topic',
  add_to_cluster:    '➕ Add cluster',
}

function approvalRate(s: ApprovalStats): number | null {
  const resolved = s.approved + s.rejected + s.executed
  if (resolved === 0) return null
  return Math.round(((s.approved + s.executed) / resolved) * 100)
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function InsightsPage() {
  const [data, setData] = useState<InsightsResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/agents/insights')
      .then(r => r.json())
      .then(setData)
      .catch(e => console.error('insights fetch failed:', e))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-8 text-gray-400">Loading insights…</div>
  if (!data)   return <div className="p-8 text-red-400">Failed to load insights.</div>

  const tyr = data.tyr

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          📊 Insights
        </h1>
        <p className="text-gray-400 mt-2 text-sm">
          Last {data.windowDays} days · Vor &amp; Saga proposals · Tyr quality trends · Topic coverage
        </p>
      </div>

      {/* ── Pending agent proposals ───────────────────────────────────────── */}
      {data.pendingMeta.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-3">Pending strategic proposals</h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {data.pendingMeta.map(p => (
              <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1.5 flex-wrap text-xs">
                  <span className="text-gray-400">{ACTION_TYPE_LABEL[p.action_type] ?? p.action_type}</span>
                  <span className="text-gray-600">·</span>
                  <span className="text-gray-500">by {AGENT_LABEL[p.agent_key] ?? p.agent_key}</span>
                  <span className="text-gray-600">·</span>
                  <span className={p.priority === 'high' ? 'text-red-400' : p.priority === 'medium' ? 'text-amber-400' : 'text-gray-500'}>
                    {p.priority}
                  </span>
                  <span className="text-gray-600 ml-auto">{timeAgo(p.created_at)}</span>
                </div>
                <h3 className="text-white text-sm font-medium mb-1 line-clamp-2">{p.title}</h3>
                <p className="text-gray-400 text-xs line-clamp-3">{p.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Tyr summary ───────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">⚖️ Tyr — quality reviews ({tyr.reviewedCount} briefs in window)</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Stat label="Mean score"     value={tyr.reviewedCount ? `${tyr.meanScore}/100`   : '—'} color="text-blue-400" />
          <Stat label="Median score"   value={tyr.reviewedCount ? `${tyr.medianScore}/100` : '—'} color="text-blue-400" />
          <Stat label="Auto-promoted"  value={String(tyr.promoted)}    color="text-green-400" />
          <Stat label="Borderline"     value={String(tyr.borderline)}  color="text-amber-400" />
          <Stat label="Failed"         value={String(tyr.failed)}      color="text-red-400" />
        </div>
      </section>

      {/* ── Approval rate per agent ──────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-3">Approval rate per agent</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-950 text-gray-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left  px-4 py-2.5">Agent</th>
                <th className="text-right px-4 py-2.5">Total</th>
                <th className="text-right px-4 py-2.5">Approved</th>
                <th className="text-right px-4 py-2.5">Rejected</th>
                <th className="text-right px-4 py-2.5">Pending</th>
                <th className="text-right px-4 py-2.5">Approval %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {Object.entries(data.approvalByAgent).sort((a, b) => b[1].total - a[1].total).map(([agent, s]) => {
                const rate = approvalRate(s)
                return (
                  <tr key={agent} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2.5 text-white">{AGENT_LABEL[agent] ?? agent}</td>
                    <td className="px-4 py-2.5 text-right text-gray-300">{s.total}</td>
                    <td className="px-4 py-2.5 text-right text-green-400">{s.approved + s.executed}</td>
                    <td className="px-4 py-2.5 text-right text-red-400">{s.rejected}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400">{s.pending}</td>
                    <td className={`px-4 py-2.5 text-right font-mono ${
                      rate === null ? 'text-gray-500' :
                      rate >= 70 ? 'text-green-400' :
                      rate >= 40 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {rate === null ? '—' : `${rate}%`}
                    </td>
                  </tr>
                )
              })}
              {Object.keys(data.approvalByAgent).length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500 text-sm">
                  No agent activity in the last {data.windowDays} days.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Topic coverage ───────────────────────────────────────────────── */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-3">📜 Topic coverage</h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-950 text-gray-500 text-xs uppercase tracking-wider">
              <tr>
                <th className="text-left  px-4 py-2.5">Topic</th>
                <th className="text-left  px-4 py-2.5">Status</th>
                <th className="text-right px-4 py-2.5">Published</th>
                <th className="text-right px-4 py-2.5">Total</th>
                <th className="text-right px-4 py-2.5">Coverage</th>
                <th className="text-right px-4 py-2.5">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/50">
              {data.topics.map(t => (
                <tr key={t.id} className="hover:bg-gray-800/30">
                  <td className="px-4 py-2.5 text-white truncate max-w-xs" title={t.topic}>{t.topic}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      t.status === 'published'   ? 'bg-green-900/40 text-green-400' :
                      t.status === 'in_progress' ? 'bg-blue-900/40 text-blue-400'  :
                      t.status === 'planning'    ? 'bg-gray-800 text-gray-400'      :
                                                   'bg-red-900/40 text-red-400'
                    }`}>{t.status}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-300">{t.published}</td>
                  <td className="px-4 py-2.5 text-right text-gray-300">{t.total}</td>
                  <td className={`px-4 py-2.5 text-right font-mono ${
                    t.coveragePct >= 70 ? 'text-green-400' :
                    t.coveragePct >= 30 ? 'text-amber-400' : 'text-red-400'
                  }`}>
                    {t.coveragePct}%
                  </td>
                  <td className="px-4 py-2.5 text-right text-gray-500 text-xs">{timeAgo(t.lastActivity)}</td>
                </tr>
              ))}
              {data.topics.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500 text-sm">
                  No topics yet — run Saga or seed via tracked_products bootstrap.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      <p className="text-gray-500 text-xs mt-1">{label}</p>
    </div>
  )
}
