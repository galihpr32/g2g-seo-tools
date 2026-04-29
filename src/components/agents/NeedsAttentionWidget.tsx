'use client'

import { useEffect, useState } from 'react'

interface AttentionItem {
  runId:         string
  agentKey:      string
  status:        'partial' | 'error'
  summary:       string | null
  errorMessage:  string | null
  findingsCount: number | null
  actionsQueued: number | null
  startedAt:     string
  finishedAt:    string | null
  durationMs:    number | null
  warnings:      string[]
}

interface ApiResponse {
  items:      AttentionItem[]
  byAgent:    Record<string, { partial: number; error: number }>
  windowDays: number
  total:      number
}

const AGENT_NAMES: Record<string, string> = {
  heimdall: 'Heimdall',
  odin:     'Odin',
  loki:     'Loki',
  bragi:    'Bragi',
  hermod:   'Hermod',
}

const AGENT_EMOJI: Record<string, string> = {
  heimdall: '👁️', odin: '🔮', loki: '🕵️', bragi: '✍️', hermod: '🤝',
}

function formatTimeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

const LS_KEY = 'needs_attention_cleared_at'

export default function NeedsAttentionWidget() {
  const [data,       setData]       = useState<ApiResponse | null>(null)
  const [loading,    setLoading]    = useState(true)
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set())
  const [clearedAt,  setClearedAt]  = useState<number>(() => {
    if (typeof window === 'undefined') return 0
    return parseInt(localStorage.getItem(LS_KEY) ?? '0', 10)
  })

  const fetchData = async () => {
    try {
      const res = await fetch('/api/agents/needs-attention?days=7')
      if (!res.ok) return
      setData(await res.json())
    } catch (err) {
      console.error('[NeedsAttentionWidget]', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 60_000)
    return () => clearInterval(iv)
  }, [])

  function handleClear() {
    const now = Date.now()
    localStorage.setItem(LS_KEY, String(now))
    setClearedAt(now)
  }

  if (loading && !data) return null
  if (!data || data.total === 0) return null

  // Filter out items that predate the last clear action
  const visibleItems = data.items.filter(
    item => new Date(item.startedAt).getTime() > clearedAt
  )
  if (visibleItems.length === 0) return null

  const partialCount = visibleItems.filter(i => i.status === 'partial').length
  const errorCount   = visibleItems.filter(i => i.status === 'error').length

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="mb-6 bg-amber-950/20 border border-amber-700/40 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-amber-800/30 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg">⚠️</span>
          <div>
            <h3 className="text-amber-200 font-semibold text-sm">Needs attention</h3>
            <p className="text-amber-200/60 text-xs">
              {errorCount > 0 && `${errorCount} failed`}
              {errorCount > 0 && partialCount > 0 && ' · '}
              {partialCount > 0 && `${partialCount} succeeded with degraded data`}
              {' '}in the last {data.windowDays}d
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleClear}
            className="text-xs text-gray-500 hover:text-gray-300 transition"
            title="Dismiss all current notifications"
          >
            Clear logs
          </button>
          <a
            href="/command-center/logs?status=partial"
            className="text-xs text-amber-300/80 hover:text-amber-200 transition"
          >
            View all →
          </a>
        </div>
      </div>

      {/* Items */}
      <div className="divide-y divide-amber-900/30">
        {visibleItems.slice(0, 5).map(item => {
          const isExpanded = expanded.has(item.runId)
          const isError    = item.status === 'error'
          const headerColor = isError ? 'text-red-300' : 'text-amber-200'
          const badgeColor  = isError
            ? 'bg-red-900/40 text-red-200 border-red-700/40'
            : 'bg-amber-900/40 text-amber-200 border-amber-700/40'

          return (
            <div key={item.runId} className="px-5 py-3">
              <button
                type="button"
                onClick={() => toggleExpand(item.runId)}
                className="w-full text-left flex items-start justify-between gap-3 group"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span>{AGENT_EMOJI[item.agentKey] ?? '🤖'}</span>
                    <span className={`text-sm font-medium ${headerColor}`}>
                      {AGENT_NAMES[item.agentKey] ?? item.agentKey}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded border ${badgeColor}`}>
                      {isError ? 'failed' : 'partial'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {formatTimeAgo(item.startedAt)}
                    </span>
                    {!isError && typeof item.actionsQueued === 'number' && (
                      <span className="text-xs text-gray-500">· {item.actionsQueued} actions queued</span>
                    )}
                  </div>
                  {item.summary && (
                    <p className="text-xs text-gray-400 mt-1 line-clamp-1 group-hover:line-clamp-none">
                      {item.summary}
                    </p>
                  )}
                </div>
                <span className="text-gray-500 text-xs flex-shrink-0">{isExpanded ? '▾' : '▸'}</span>
              </button>

              {isExpanded && (
                <div className="mt-3 space-y-2 pl-7">
                  {item.warnings.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-wider text-gray-500 mb-1">
                        {isError ? 'Error' : 'Warnings'}
                      </p>
                      <ul className="space-y-1">
                        {item.warnings.map((w, i) => (
                          <li key={i} className="text-xs text-gray-300 bg-black/30 rounded px-2 py-1 border border-gray-800/50">
                            {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    {item.durationMs !== null && (
                      <span>Duration: {(item.durationMs / 1000).toFixed(1)}s</span>
                    )}
                    {item.findingsCount !== null && (
                      <span>Findings: {item.findingsCount}</span>
                    )}
                    <a
                      href={`/command-center/logs?run=${item.runId}`}
                      className="text-amber-300/80 hover:text-amber-200 transition ml-auto"
                    >
                      Open in Activity Log →
                    </a>
                  </div>
                </div>
              )}
            </div>
          )
        })}

        {visibleItems.length > 5 && (
          <a
            href="/command-center/logs?status=partial"
            className="block px-5 py-2.5 text-center text-xs text-amber-300/80 hover:text-amber-200 hover:bg-amber-900/10 transition"
          >
            +{visibleItems.length - 5} more — view all
          </a>
        )}
      </div>
    </div>
  )
}
