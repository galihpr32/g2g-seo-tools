'use client'

import { useState, useMemo } from 'react'

interface SignalEntry {
  action_id:     string
  agent_key:     string
  created_at:    string
  keyword?:      string
  search_volume?: number
  page?:         string
  clicks_drop?:  number
  game_name?:    string
  [key: string]: unknown
}

interface Opportunity {
  id:               string
  topic:            string
  topic_slug:       string
  target_url:       string | null
  status:           string
  output_type:      string | null
  signal_count:     number
  total_sv:         number
  created_at:       string
  updated_at:       string
  last_signal_at:   string | null
  brief_id:         string | null
  tyr_score:        number | null
  tyr_status:       string | null
  heimdall_signals: SignalEntry[]
  loki_signals:     SignalEntry[]
  odin_signals:     SignalEntry[]
}

interface Props {
  initialOpportunities: Opportunity[]
  statusCounts: Record<string, number>
}

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
  new:          { label: 'New',          color: 'bg-blue-900/40 text-blue-300 border-blue-700/40',   dot: 'bg-blue-400'   },
  in_review:    { label: 'In Review',    color: 'bg-amber-900/40 text-amber-300 border-amber-700/40', dot: 'bg-amber-400'  },
  brief_queued: { label: 'Brief Queued', color: 'bg-indigo-900/40 text-indigo-300 border-indigo-700/40', dot: 'bg-indigo-400' },
  brief_ready:  { label: 'Brief Ready',  color: 'bg-green-900/40 text-green-300 border-green-700/40', dot: 'bg-green-400'  },
  published:    { label: 'Published',    color: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40', dot: 'bg-emerald-400' },
  dismissed:    { label: 'Dismissed',    color: 'bg-gray-900/40 text-gray-500 border-gray-700/40',   dot: 'bg-gray-600'   },
}

const OUTPUT_TYPE_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  new_page:          { label: 'New Page',          icon: '📄', color: 'text-blue-400'   },
  optimize_existing: { label: 'Optimise Existing', icon: '✏️',  color: 'text-amber-400' },
  outreach:          { label: 'Outreach',           icon: '🤝', color: 'text-green-400' },
}

function formatSV(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return n.toString()
}

function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function SourceBadges({ opp }: { opp: Opportunity }) {
  const hasHeimdall = opp.heimdall_signals?.length > 0
  const hasLoki     = opp.loki_signals?.length > 0
  const hasOdin     = opp.odin_signals?.length > 0
  return (
    <div className="flex items-center gap-1">
      {hasHeimdall && (
        <span title={`${opp.heimdall_signals.length} Heimdall signal${opp.heimdall_signals.length > 1 ? 's' : ''} (ranking drop)`}
          className="px-1.5 py-0.5 text-[10px] rounded bg-red-900/40 text-red-300 border border-red-700/30">
          👁️ {opp.heimdall_signals.length}
        </span>
      )}
      {hasLoki && (
        <span title={`${opp.loki_signals.length} Loki signal${opp.loki_signals.length > 1 ? 's' : ''} (keyword gap)`}
          className="px-1.5 py-0.5 text-[10px] rounded bg-purple-900/40 text-purple-300 border border-purple-700/30">
          🕵️ {opp.loki_signals.length}
        </span>
      )}
      {hasOdin && (
        <span title={`${opp.odin_signals.length} Odin signal${opp.odin_signals.length > 1 ? 's' : ''} (trending)`}
          className="px-1.5 py-0.5 text-[10px] rounded bg-amber-900/40 text-amber-300 border border-amber-700/30">
          🔮 {opp.odin_signals.length}
        </span>
      )}
    </div>
  )
}

export default function OpportunitiesClient({ initialOpportunities, statusCounts }: Props) {
  const [opportunities, setOpportunities] = useState<Opportunity[]>(initialOpportunities)
  const [statusFilter,  setStatusFilter]  = useState<string>('all_active')
  const [agentFilter,   setAgentFilter]   = useState<string>('all')
  const [sortBy,        setSortBy]        = useState<'updated_at' | 'signal_count' | 'total_sv'>('updated_at')
  const [selected,      setSelected]      = useState<Set<string>>(new Set())
  const [expanded,      setExpanded]      = useState<string | null>(null)
  const [saving,        setSaving]        = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)

  // Filtered + sorted list
  const filtered = useMemo(() => {
    let list = opportunities

    if (statusFilter === 'all_active') {
      list = list.filter(o => o.status !== 'dismissed')
    } else if (statusFilter !== 'all') {
      list = list.filter(o => o.status === statusFilter)
    }

    if (!showDismissed && statusFilter !== 'dismissed') {
      list = list.filter(o => o.status !== 'dismissed')
    }

    if (agentFilter === 'heimdall') list = list.filter(o => o.heimdall_signals?.length > 0)
    if (agentFilter === 'loki')     list = list.filter(o => o.loki_signals?.length > 0)
    if (agentFilter === 'odin')     list = list.filter(o => o.odin_signals?.length > 0)
    if (agentFilter === 'multi')    list = list.filter(o => {
      const sources = [o.heimdall_signals?.length > 0, o.loki_signals?.length > 0, o.odin_signals?.length > 0].filter(Boolean).length
      return sources >= 2
    })

    list = [...list].sort((a, b) => {
      if (sortBy === 'signal_count') return b.signal_count - a.signal_count
      if (sortBy === 'total_sv')     return b.total_sv - a.total_sv
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    })

    return list
  }, [opportunities, statusFilter, agentFilter, sortBy, showDismissed])

  // Bulk update
  async function patchOpportunities(ids: string[], patch: { status?: string; output_type?: string }) {
    setSaving(true)
    try {
      const res = await fetch('/api/opportunities', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids, ...patch }),
      })
      if (!res.ok) throw new Error('Update failed')
      // Optimistic update
      setOpportunities(prev =>
        prev.map(o => ids.includes(o.id) ? { ...o, ...patch } : o)
      )
      setSelected(new Set())
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map(o => o.id)))
    }
  }

  const totalNew = statusCounts['new'] ?? 0
  const totalActive = Object.entries(statusCounts)
    .filter(([s]) => s !== 'dismissed')
    .reduce((sum, [, n]) => sum + n, 0)

  return (
    <div>
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total Active',   value: totalActive,                       color: 'text-white'       },
          { label: 'New',            value: totalNew,                           color: 'text-blue-400'    },
          { label: 'Brief Queued',   value: statusCounts['brief_queued'] ?? 0, color: 'text-indigo-400'  },
          { label: 'Multi-source',   value: opportunities.filter(o =>
              [o.heimdall_signals?.length > 0, o.loki_signals?.length > 0, o.odin_signals?.length > 0].filter(Boolean).length >= 2
            ).length,                                                            color: 'text-amber-400'   },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Filters + sort */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none"
        >
          <option value="all_active">All Active</option>
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.label}</option>
          ))}
          <option value="all">All (incl. dismissed)</option>
        </select>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none"
        >
          <option value="all">All Agents</option>
          <option value="heimdall">👁️ Heimdall only</option>
          <option value="loki">🕵️ Loki only</option>
          <option value="odin">🔮 Odin only</option>
          <option value="multi">⚡ Multi-source (2+ agents)</option>
        </select>

        {/* Sort */}
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value as typeof sortBy)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none"
        >
          <option value="updated_at">Sort: Recent</option>
          <option value="signal_count">Sort: Signal Count</option>
          <option value="total_sv">Sort: Search Volume</option>
        </select>

        <span className="text-xs text-gray-500 ml-auto">{filtered.length} opportunities</span>
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-3 bg-gray-800 border border-gray-700 rounded-xl">
          <span className="text-sm text-gray-300 font-medium">{selected.size} selected</span>
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => patchOpportunities(Array.from(selected), { status: 'in_review' })}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-amber-700 text-white hover:bg-amber-600 disabled:opacity-50 transition"
            >
              Mark In Review
            </button>
            <button
              onClick={() => patchOpportunities(Array.from(selected), { status: 'brief_queued' })}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
            >
              Queue Brief
            </button>
            <button
              onClick={() => patchOpportunities(Array.from(selected), { status: 'dismissed' })}
              disabled={saving}
              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-700 text-white hover:bg-gray-600 disabled:opacity-50 transition"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-4">🎯</p>
          <p className="text-white font-semibold text-lg mb-2">No opportunities yet</p>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            Run <strong className="text-blue-400">Detection agents</strong> (Heimdall, Loki, Odin) from the Command Center.
            After they complete, Saga will automatically group their signals into opportunities here.
          </p>
          <a
            href="/command-center"
            className="inline-block mt-6 px-5 py-2.5 bg-blue-700 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition"
          >
            Go to Command Center →
          </a>
        </div>
      )}

      {/* Opportunities list */}
      {filtered.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-2.5 border-b border-gray-800 text-xs text-gray-500 font-medium uppercase tracking-wider">
            <input
              type="checkbox"
              checked={selected.size === filtered.length && filtered.length > 0}
              onChange={toggleAll}
              className="rounded border-gray-600"
            />
            <span>Topic</span>
            <span>Sources</span>
            <span className="text-right">Signals</span>
            <span className="text-right">SV</span>
            <span className="text-right">Updated</span>
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-800/60">
            {filtered.map(opp => {
              const statusCfg = STATUS_CONFIG[opp.status] ?? STATUS_CONFIG['new']
              const isExpanded = expanded === opp.id
              const isSelected = selected.has(opp.id)

              return (
                <div key={opp.id} className={`${isSelected ? 'bg-indigo-950/20' : 'hover:bg-gray-800/30'} transition`}>
                  {/* Main row */}
                  <div
                    className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-4 items-center px-4 py-3 cursor-pointer"
                    onClick={() => setExpanded(isExpanded ? null : opp.id)}
                  >
                    {/* Checkbox */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={e => { e.stopPropagation(); toggleSelect(opp.id) }}
                      className="rounded border-gray-600"
                      onClick={e => e.stopPropagation()}
                    />

                    {/* Topic */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-medium text-sm truncate">{opp.topic}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusCfg.color}`}>
                          {statusCfg.label}
                        </span>
                        {opp.output_type && (
                          <span className={`text-[10px] ${OUTPUT_TYPE_CONFIG[opp.output_type]?.color ?? 'text-gray-400'}`}>
                            {OUTPUT_TYPE_CONFIG[opp.output_type]?.icon} {OUTPUT_TYPE_CONFIG[opp.output_type]?.label}
                          </span>
                        )}
                      </div>
                      {opp.target_url && (
                        <p className="text-xs text-gray-500 truncate mt-0.5 max-w-sm">{opp.target_url}</p>
                      )}
                    </div>

                    {/* Source badges */}
                    <SourceBadges opp={opp} />

                    {/* Signal count */}
                    <span className="text-right text-sm font-semibold text-gray-300 tabular-nums">
                      {opp.signal_count}
                    </span>

                    {/* Search volume */}
                    <span className="text-right text-sm text-gray-400 tabular-nums">
                      {opp.total_sv > 0 ? formatSV(opp.total_sv) : '—'}
                    </span>

                    {/* Updated */}
                    <span className="text-right text-xs text-gray-500 whitespace-nowrap">
                      {timeAgo(opp.last_signal_at ?? opp.updated_at)}
                    </span>
                  </div>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="border-t border-gray-800 bg-gray-950/40 px-6 py-4">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">

                        {/* Heimdall signals */}
                        {opp.heimdall_signals?.length > 0 && (
                          <div>
                            <p className="text-xs font-bold text-red-400 uppercase tracking-wider mb-2">
                              👁️ Heimdall — Ranking Drops
                            </p>
                            <ul className="space-y-1">
                              {opp.heimdall_signals.slice(0, 5).map(s => (
                                <li key={s.action_id} className="text-xs text-gray-400">
                                  <span className="text-red-300 font-medium">
                                    {s.clicks_drop_pct ? `-${Number(s.clicks_drop_pct).toFixed(0)}%` : ''}
                                  </span>
                                  {' '}
                                  <span className="truncate">
                                    {String(s.page ?? '').replace(/^https?:\/\/[^/]+/, '') || 'page'}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Loki signals */}
                        {opp.loki_signals?.length > 0 && (
                          <div>
                            <p className="text-xs font-bold text-purple-400 uppercase tracking-wider mb-2">
                              🕵️ Loki — Keyword Gaps
                            </p>
                            <ul className="space-y-1">
                              {opp.loki_signals.slice(0, 5).map(s => (
                                <li key={s.action_id} className="text-xs text-gray-400">
                                  <span className="text-white">{String(s.keyword ?? '')}</span>
                                  {s.search_volume ? (
                                    <span className="text-gray-500"> · {formatSV(Number(s.search_volume))} SV</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Odin signals */}
                        {opp.odin_signals?.length > 0 && (
                          <div>
                            <p className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">
                              🔮 Odin — Trending
                            </p>
                            <ul className="space-y-1">
                              {opp.odin_signals.slice(0, 5).map(s => (
                                <li key={s.action_id} className="text-xs text-gray-400">
                                  <span className="text-white">{String(s.game_name ?? '')}</span>
                                  {s.search_volume ? (
                                    <span className="text-gray-500"> · {formatSV(Number(s.search_volume))} SV</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-gray-800">
                        <p className="text-xs text-gray-500 mr-2">Output type:</p>
                        {Object.entries(OUTPUT_TYPE_CONFIG).map(([key, cfg]) => (
                          <button
                            key={key}
                            onClick={() => patchOpportunities([opp.id], { output_type: key })}
                            disabled={saving}
                            className={`px-3 py-1.5 rounded text-xs font-medium border transition disabled:opacity-50 ${
                              opp.output_type === key
                                ? 'bg-indigo-700 border-indigo-600 text-white'
                                : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
                            }`}
                          >
                            {cfg.icon} {cfg.label}
                          </button>
                        ))}

                        <div className="ml-auto flex items-center gap-2">
                          {opp.status !== 'brief_queued' && opp.status !== 'brief_ready' && (
                            <button
                              onClick={() => patchOpportunities([opp.id], { status: 'brief_queued' })}
                              disabled={saving}
                              className="px-3 py-1.5 rounded text-xs font-medium bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                            >
                              ✍️ Queue Brief
                            </button>
                          )}
                          {opp.brief_id && (
                            <a
                              href={`/content/briefs/${opp.brief_id}`}
                              className="px-3 py-1.5 rounded text-xs font-medium bg-green-800 text-green-100 hover:bg-green-700 transition"
                            >
                              📄 View Brief
                            </a>
                          )}
                          {opp.status !== 'dismissed' && (
                            <button
                              onClick={() => patchOpportunities([opp.id], { status: 'dismissed' })}
                              disabled={saving}
                              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-50 transition"
                            >
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
