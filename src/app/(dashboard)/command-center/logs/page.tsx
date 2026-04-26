'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentRun {
  id: string
  agent_key: string
  site_slug: string
  status: string
  summary: string | null
  findings_count: number
  actions_queued: number
  error_message: string | null
  triggered_by_action_id: string | null
  started_at: string
  finished_at: string | null
  durationMs: number | null
}

interface AgentAction {
  id: string
  agent_key: string
  run_id: string | null
  site_slug: string
  action_type: string
  title: string
  description: string | null
  priority: string
  status: string
  approved_at: string | null
  executed_at: string | null
  created_at: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_NAMES: Record<string, string> = {
  'heimdall': 'Heimdall',
  'odin':     'Odin',
  'loki':     'Loki',
  'bragi':    'Bragi',
  'hermod':   'Hermod',
  'tyr':      'Tyr',
  'mimir':    'Mimir',
}

const AGENT_COLORS: Record<string, string> = {
  'heimdall': 'bg-blue-900/50 text-blue-300',
  'odin':     'bg-green-900/50 text-green-300',
  'loki':     'bg-purple-900/50 text-purple-300',
  'bragi':    'bg-yellow-900/50 text-yellow-300',
  'hermod':   'bg-orange-900/50 text-orange-300',
  'tyr':      'bg-amber-900/50 text-amber-300',
  'mimir':    'bg-indigo-900/50 text-indigo-300',
}

const STATUS_STYLES: Record<string, string> = {
  success:  'bg-green-900/40 text-green-400',
  partial:  'bg-amber-900/40 text-amber-300',
  error:    'bg-red-900/40 text-red-400',
  running:  'bg-blue-900/40 text-blue-400',
  pending:  'bg-gray-800 text-gray-400',
  approved: 'bg-green-900/40 text-green-400',
  rejected: 'bg-red-900/40 text-red-400',
  executed: 'bg-purple-900/40 text-purple-400',
}

const STATUS_ICONS: Record<string, string> = {
  success:  '✅',
  partial:  '⚠️',
  error:    '❌',
  running:  '⏳',
  pending:  '🕐',
  approved: '✅',
  rejected: '🚫',
  executed: '⚡',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function formatDuration(ms: number | null) {
  if (!ms) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function Badge({ text, className }: { text: string; className: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${className}`}>
      {text}
    </span>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function AgentLogsPage() {
  const searchParams = useSearchParams()
  const initialStatus = searchParams.get('status') ?? ''
  const initialAgent  = searchParams.get('agent')  ?? ''
  const initialRunId  = searchParams.get('run')

  const [tab, setTab] = useState<'runs' | 'actions'>('runs')
  const [agentFilter, setAgentFilter] = useState(initialAgent)
  const [statusFilter, setStatusFilter] = useState(initialStatus)

  const [runs, setRuns] = useState<AgentRun[]>([])
  const [actions, setActions] = useState<AgentAction[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedRun, setExpandedRun] = useState<string | null>(initialRunId)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ tab, limit: '100' })
      if (agentFilter)  params.set('agent', agentFilter)
      if (statusFilter) params.set('status', statusFilter)

      const res = await fetch(`/api/agents/logs?${params}`)
      const data = await res.json() as Record<string, unknown>

      if (tab === 'runs')    setRuns((data.runs as AgentRun[]) ?? [])
      if (tab === 'actions') setActions((data.actions as AgentAction[]) ?? [])
    } catch (e) {
      console.error('Failed to load logs:', e)
    } finally {
      setLoading(false)
    }
  }, [tab, agentFilter, statusFilter])

  useEffect(() => { fetchData() }, [fetchData])

  // Stats summary
  const runStats = {
    total:   runs.length,
    success: runs.filter(r => r.status === 'success').length,
    partial: runs.filter(r => r.status === 'partial').length,
    error:   runs.filter(r => r.status === 'error').length,
    totalFindings: runs.reduce((s, r) => s + (r.findings_count ?? 0), 0),
    totalQueued:   runs.reduce((s, r) => s + (r.actions_queued ?? 0), 0),
  }

  const actionStats = {
    total:    actions.length,
    pending:  actions.filter(a => a.status === 'pending').length,
    approved: actions.filter(a => a.status === 'approved').length,
    executed: actions.filter(a => a.status === 'executed').length,
    rejected: actions.filter(a => a.status === 'rejected').length,
  }

  return (
    <div className="p-8 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <a href="/command-center" className="text-gray-500 hover:text-gray-300 text-sm transition">
              ← Command Center
            </a>
          </div>
          <h1 className="text-2xl font-bold text-white">Agent Activity Log</h1>
          <p className="text-gray-400 text-sm mt-1">Full history of all agent runs and actions</p>
        </div>
        <button
          onClick={fetchData}
          className="px-4 py-2 rounded text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 transition"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(['runs', 'actions'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition ${
              tab === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
            }`}
          >
            {t === 'runs' ? '⚙️ Run History' : '📋 Action History'}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-3 mb-6 flex-wrap">
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="">All Agents</option>
          {Object.entries(AGENT_NAMES).map(([key, name]) => (
            <option key={key} value={key}>{name}</option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
        >
          <option value="">All Statuses</option>
          {tab === 'runs'
            ? ['success', 'partial', 'error', 'running'].map(s => <option key={s} value={s}>{s}</option>)
            : ['pending', 'approved', 'executed', 'rejected'].map(s => <option key={s} value={s}>{s}</option>)
          }
        </select>
      </div>

      {/* ── RUN HISTORY TAB ── */}
      {tab === 'runs' && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 mb-6">
            {[
              { label: 'Total Runs',    value: runStats.total },
              { label: 'Successful',    value: runStats.success,       color: 'text-green-400' },
              { label: 'Partial',       value: runStats.partial,       color: 'text-amber-400' },
              { label: 'Errors',        value: runStats.error,         color: 'text-red-400' },
              { label: 'Total Findings',value: runStats.totalFindings, color: 'text-blue-400' },
              { label: 'Actions Queued',value: runStats.totalQueued,   color: 'text-purple-400' },
            ].map(s => (
              <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className={`text-2xl font-bold ${s.color ?? 'text-white'}`}>{s.value}</p>
                <p className="text-gray-500 text-xs mt-1">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Run list */}
          {loading ? (
            <div className="text-center py-16 text-gray-500">Loading...</div>
          ) : runs.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p className="text-4xl mb-3">📭</p>
              <p>No runs found. Try running an agent from the Command Center.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map(run => (
                <div key={run.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                    className="w-full text-left px-5 py-4 hover:bg-gray-800/50 transition"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 flex-wrap min-w-0">
                        <Badge
                          text={AGENT_NAMES[run.agent_key] ?? run.agent_key}
                          className={AGENT_COLORS[run.agent_key] ?? 'bg-gray-800 text-gray-300'}
                        />
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[run.status] ?? 'bg-gray-800 text-gray-400'}`}>
                          {STATUS_ICONS[run.status]} {run.status}
                        </span>
                        {run.triggered_by_action_id && (
                          <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
                            ↩ handoff triggered
                          </span>
                        )}
                        <span className="text-gray-300 text-sm truncate">
                          {run.summary ?? (run.status === 'running' ? 'In progress...' : '—')}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-gray-500 flex-shrink-0">
                        <span>{run.findings_count} found · {run.actions_queued} queued</span>
                        <span>{formatDuration(run.durationMs)}</span>
                        <span>{formatDate(run.started_at)}</span>
                        <span className="text-gray-600">{expandedRun === run.id ? '▲' : '▼'}</span>
                      </div>
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {expandedRun === run.id && (
                    <div className="border-t border-gray-800 bg-gray-950 px-5 py-4 text-sm space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Run ID</p>
                          <p className="text-gray-300 font-mono text-xs break-all">{run.id}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Site</p>
                          <p className="text-gray-300">{run.site_slug}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Started</p>
                          <p className="text-gray-300">{formatDate(run.started_at)}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Finished</p>
                          <p className="text-gray-300">{run.finished_at ? formatDate(run.finished_at) : '—'}</p>
                        </div>
                      </div>

                      {run.error_message && (
                        <div className="bg-red-950/50 border border-red-900/50 rounded-lg px-4 py-3">
                          <p className="text-xs text-red-400 font-medium mb-1">⚠️ Error</p>
                          <p className="text-red-300 text-xs font-mono">{run.error_message}</p>
                        </div>
                      )}

                      {run.summary && (
                        <div className="bg-gray-900 rounded-lg px-4 py-3">
                          <p className="text-xs text-gray-500 mb-1">Summary</p>
                          <p className="text-gray-300 text-xs">{run.summary}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── ACTION HISTORY TAB ── */}
      {tab === 'actions' && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Total',    value: actionStats.total },
              { label: 'Pending',  value: actionStats.pending,  color: 'text-gray-300' },
              { label: 'Approved', value: actionStats.approved, color: 'text-green-400' },
              { label: 'Executed', value: actionStats.executed, color: 'text-purple-400' },
            ].map(s => (
              <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className={`text-2xl font-bold ${s.color ?? 'text-white'}`}>{s.value}</p>
                <p className="text-gray-500 text-xs mt-1">{s.label}</p>
              </div>
            ))}
          </div>

          {/* Action list */}
          {loading ? (
            <div className="text-center py-16 text-gray-500">Loading...</div>
          ) : actions.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <p className="text-4xl mb-3">📭</p>
              <p>No actions found for the selected filters.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-900 border-b border-gray-800">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Date</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Agent</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Action</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Priority</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Status</th>
                    <th className="px-4 py-3 text-left text-xs text-gray-400 font-medium">Resolved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {actions.map(action => (
                    <tr key={action.id} className="bg-gray-900/50 hover:bg-gray-900 transition">
                      <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">
                        {formatDate(action.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          text={AGENT_NAMES[action.agent_key] ?? action.agent_key}
                          className={AGENT_COLORS[action.agent_key] ?? 'bg-gray-800 text-gray-300'}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-gray-200 text-xs font-medium leading-snug">{action.title}</p>
                        {action.description && (
                          <p className="text-gray-500 text-xs mt-0.5 line-clamp-1">{action.description}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${
                          action.priority === 'high' ? 'text-red-400' :
                          action.priority === 'medium' ? 'text-yellow-400' : 'text-gray-400'
                        }`}>
                          {action.priority === 'high' ? '🔴' : action.priority === 'medium' ? '🟡' : '🟢'} {action.priority}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[action.status] ?? 'bg-gray-800 text-gray-400'}`}>
                          {STATUS_ICONS[action.status]} {action.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {action.executed_at
                          ? formatDate(action.executed_at)
                          : action.approved_at
                          ? formatDate(action.approved_at)
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
