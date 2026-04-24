'use client'

import { useState, useEffect, useMemo } from 'react'

interface AgentAction {
  id: string
  agent_key: string
  action_type: string
  title: string
  description: string | null
  priority: string
  status: string
  created_at: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENTS = [
  { key: 'all',        label: 'All',        emoji: '📋' },
  { key: 'heimdall',     label: 'Heimdall',     emoji: '🔍' },
  { key: 'odin',  label: 'Odin',  emoji: '📈' },
  { key: 'loki',label: 'Loki',emoji: '🕵️' },
  { key: 'bragi',label: 'Bragi',emoji: '✍️' },
  { key: 'hermod', label: 'Hermod', emoji: '🤝' },
]

const AGENT_BADGE: Record<string, string> = {
  'heimdall':      'bg-blue-900/60 text-blue-300 border border-blue-700/40',
  'odin':   'bg-green-900/60 text-green-300 border border-green-700/40',
  'loki': 'bg-purple-900/60 text-purple-300 border border-purple-700/40',
  'bragi': 'bg-yellow-900/60 text-yellow-300 border border-yellow-700/40',
  'hermod':  'bg-orange-900/60 text-orange-300 border border-orange-700/40',
}

const PRIORITY_CONFIG: Record<string, { label: string; dot: string; text: string }> = {
  high:   { label: 'High',   dot: 'bg-red-500',    text: 'text-red-400' },
  medium: { label: 'Medium', dot: 'bg-yellow-500', text: 'text-yellow-400' },
  low:    { label: 'Low',    dot: 'bg-gray-500',   text: 'text-gray-400' },
}

type SortKey = 'created_at' | 'priority'

// ── Component ─────────────────────────────────────────────────────────────────

interface ApprovalQueueWidgetProps {
  userId: string
}

export default function ApprovalQueueWidget({ userId: _ }: ApprovalQueueWidgetProps) {
  const [actions, setActions]           = useState<AgentAction[]>([])
  const [loading, setLoading]           = useState(true)
  const [activeAgent, setActiveAgent]   = useState('all')
  const [priorityFilter, setPriority]   = useState('all')
  const [sortKey, setSortKey]           = useState<SortKey>('created_at')
  const [sortDir, setSortDir]           = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected]         = useState<Set<string>>(new Set())
  const [processing, setProcessing]     = useState<Set<string>>(new Set())
  const [bulkProcessing, setBulkProcessing] = useState(false)

  const fetchActions = async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      const res = await fetch('/api/agents/actions?status=pending&limit=200')
      const data = await res.json() as { actions?: AgentAction[] }
      const incoming = data.actions ?? []
      // Silent refresh: only update if count changed to avoid disrupting the list
      setActions(prev => {
        if (silent && prev.length === incoming.length) return prev
        return incoming
      })
    } catch (e) {
      console.error('Failed to fetch actions:', e)
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    fetchActions()
    // Poll every 2 minutes silently — only resets list if count changes
    const t = setInterval(() => fetchActions(true), 120000)
    return () => clearInterval(t)
  }, [])

  // ── Derived data ─────────────────────────────────────────────────────────────

  // Count per agent tab
  const countByAgent = useMemo(() => {
    const map: Record<string, number> = { all: actions.length }
    for (const a of actions) map[a.agent_key] = (map[a.agent_key] ?? 0) + 1
    return map
  }, [actions])

  // Filtered + sorted list
  const visible = useMemo(() => {
    let list = actions
    if (activeAgent !== 'all')   list = list.filter(a => a.agent_key === activeAgent)
    if (priorityFilter !== 'all') list = list.filter(a => a.priority === priorityFilter)

    return [...list].sort((a, b) => {
      if (sortKey === 'priority') {
        const order = { high: 0, medium: 1, low: 2 }
        const diff = (order[a.priority as keyof typeof order] ?? 1) - (order[b.priority as keyof typeof order] ?? 1)
        return sortDir === 'asc' ? diff : -diff
      }
      const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      return sortDir === 'asc' ? diff : -diff
    })
  }, [actions, activeAgent, priorityFilter, sortKey, sortDir])

  // ── Actions ───────────────────────────────────────────────────────────────────

  const removeIds = (ids: string[]) =>
    setActions(prev => prev.filter(a => !ids.includes(a.id)))

  const act = async (id: string, status: 'approved' | 'rejected') => {
    setProcessing(prev => new Set([...prev, id]))
    try {
      await fetch('/api/agents/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status }),
      })
      removeIds([id])
      setSelected(prev => { const n = new Set(prev); n.delete(id); return n })
    } finally {
      setProcessing(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }

  const bulkAct = async (status: 'approved' | 'rejected') => {
    if (!selected.size) return
    setBulkProcessing(true)
    const ids = [...selected]
    try {
      await Promise.all(ids.map(id =>
        fetch('/api/agents/actions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, status }),
        })
      ))
      removeIds(ids)
      setSelected(new Set())
    } finally {
      setBulkProcessing(false)
    }
  }

  const toggleSelect = (id: string) =>
    setSelected(prev => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const toggleSelectAll = () => {
    if (selected.size === visible.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(visible.map(a => a.id)))
    }
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const formatDate = (iso: string) => {
    const d = new Date(iso)
    const now = new Date()
    const diff = Math.floor((now.getTime() - d.getTime()) / 1000)
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-gray-500 text-sm">Loading...</p>
      </div>
    )
  }

  if (actions.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
        <p className="text-2xl mb-2">✅</p>
        <p className="text-gray-400 text-sm">All clear — no pending actions.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

      {/* ── Agent tabs ── */}
      <div className="flex gap-0 border-b border-gray-800 overflow-x-auto">
        {AGENTS.map(ag => {
          const count = countByAgent[ag.key] ?? 0
          if (ag.key !== 'all' && count === 0) return null
          return (
            <button
              key={ag.key}
              onClick={() => { setActiveAgent(ag.key); setSelected(new Set()) }}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition ${
                activeAgent === ag.key
                  ? 'border-blue-500 text-white bg-gray-800/50'
                  : 'border-transparent text-gray-400 hover:text-white hover:bg-gray-800/30'
              }`}
            >
              <span>{ag.emoji}</span>
              <span>{ag.label}</span>
              {count > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
                  activeAgent === ag.key ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'
                }`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Toolbar: filter + sort + select-all ── */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800 flex-wrap">
        <div className="flex items-center gap-2">
          {/* Select all */}
          <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-400 hover:text-white">
            <input
              type="checkbox"
              checked={visible.length > 0 && selected.size === visible.length}
              onChange={toggleSelectAll}
              className="w-3.5 h-3.5 rounded accent-blue-500"
            />
            {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
          </label>

          {/* Priority filter */}
          <select
            value={priorityFilter}
            onChange={e => setPriority(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option value="all">All priorities</option>
            <option value="high">🔴 High</option>
            <option value="medium">🟡 Medium</option>
            <option value="low">🟢 Low</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          {/* Sort */}
          <span className="text-xs text-gray-500">Sort:</span>
          {(['created_at', 'priority'] as SortKey[]).map(k => (
            <button
              key={k}
              onClick={() => toggleSort(k)}
              className={`px-2 py-1 rounded text-xs transition ${
                sortKey === k ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-white'
              }`}
            >
              {k === 'created_at' ? 'Date' : 'Priority'}
              {sortKey === k && (sortDir === 'desc' ? ' ↓' : ' ↑')}
            </button>
          ))}

          <button
            onClick={() => fetchActions()}
            className="px-2 py-1 rounded text-xs text-gray-500 hover:text-white transition"
            title="Refresh"
          >
            🔄
          </button>
        </div>
      </div>

      {/* ── Bulk action bar ── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-950/40 border-b border-blue-800/30">
          <span className="text-xs text-blue-300 font-medium">{selected.size} selected</span>
          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => bulkAct('rejected')}
              disabled={bulkProcessing}
              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-200 hover:bg-gray-600 transition disabled:opacity-50"
            >
              {bulkProcessing ? '...' : '🚫 Reject all'}
            </button>
            <button
              onClick={() => bulkAct('approved')}
              disabled={bulkProcessing}
              className="px-3 py-1.5 rounded text-xs font-medium bg-green-700 text-white hover:bg-green-600 transition disabled:opacity-50"
            >
              {bulkProcessing ? '...' : '✅ Approve all'}
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="px-2 py-1.5 rounded text-xs text-gray-400 hover:text-white transition"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── Action list ── */}
      {visible.length === 0 ? (
        <div className="p-8 text-center text-gray-500 text-sm">
          No actions match the current filters.
        </div>
      ) : (
        <div className="divide-y divide-gray-800/60">
          {visible.map(action => {
            const isSelected  = selected.has(action.id)
            const isProcessing = processing.has(action.id)
            const pc = PRIORITY_CONFIG[action.priority] ?? PRIORITY_CONFIG.medium

            return (
              <div
                key={action.id}
                className={`flex items-start gap-3 px-4 py-3.5 transition ${
                  isSelected ? 'bg-blue-950/20' : 'hover:bg-gray-800/40'
                }`}
              >
                {/* Checkbox */}
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(action.id)}
                  className="mt-0.5 w-3.5 h-3.5 rounded accent-blue-500 flex-shrink-0"
                />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-2 flex-wrap mb-1">
                    {/* Agent badge */}
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-semibold ${AGENT_BADGE[action.agent_key] ?? 'bg-gray-800 text-gray-300'}`}>
                      {action.agent_key.toUpperCase()}
                    </span>

                    {/* Priority dot */}
                    <span className={`flex items-center gap-1 text-xs ${pc.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full inline-block ${pc.dot}`} />
                      {pc.label}
                    </span>

                    {/* Action type */}
                    <span className="text-xs text-gray-600 bg-gray-800/60 px-1.5 py-0.5 rounded">
                      {action.action_type.replace(/_/g, ' ')}
                    </span>
                  </div>

                  <p className="text-white text-sm font-medium leading-snug">{action.title}</p>
                  {action.description && (
                    <p className="text-gray-400 text-xs mt-0.5 line-clamp-2">{action.description}</p>
                  )}
                  <p className="text-gray-600 text-xs mt-1">{formatDate(action.created_at)}</p>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5 flex-shrink-0 mt-0.5">
                  <button
                    onClick={() => act(action.id, 'rejected')}
                    disabled={isProcessing}
                    className="px-2.5 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition disabled:opacity-40"
                  >
                    {isProcessing ? '…' : 'Reject'}
                  </button>
                  <button
                    onClick={() => act(action.id, 'approved')}
                    disabled={isProcessing}
                    className="px-2.5 py-1.5 rounded text-xs font-medium bg-green-700 text-white hover:bg-green-600 transition disabled:opacity-40"
                  >
                    {isProcessing ? '…' : 'Approve'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      <div className="px-4 py-2 border-t border-gray-800 text-xs text-gray-600 flex justify-between">
        <span>{visible.length} action{visible.length !== 1 ? 's' : ''} shown</span>
        <span>Auto-refreshes every 30s</span>
      </div>
    </div>
  )
}
