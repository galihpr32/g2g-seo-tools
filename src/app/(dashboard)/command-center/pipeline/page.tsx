'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import type { JourneyItem, PipelineStageInfo } from '@/app/api/pipeline-journey/route'

// ── Stage config ──────────────────────────────────────────────────────────────

const STAGES = [
  { n: 1, label: 'Detection',   agents: 'Heimdall · Loki · Odin', color: 'blue'   },
  { n: 2, label: 'Aggregation', agents: 'Saga',                   color: 'purple' },
  { n: 3, label: 'Triage',      agents: 'You',                    color: 'amber'  },
  { n: 4, label: 'Brief',       agents: 'Bragi · Tyr',            color: 'indigo' },
  { n: 5, label: 'Execute',     agents: 'Writer',                  color: 'green'  },
  { n: 6, label: 'Outreach',    agents: 'Hermod',                  color: 'pink'   },
  { n: 7, label: 'Measure',     agents: 'Vor',                     color: 'teal'   },
] as const

type StageColor = typeof STAGES[number]['color']

const COLOR: Record<StageColor, { dot: string; badge: string; icon: string; text: string; border: string }> = {
  blue:   { dot: 'bg-blue-500',   badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',   icon: 'bg-blue-500/20 border-blue-500/40 text-blue-400',   text: 'text-blue-400',   border: 'border-blue-500/40' },
  purple: { dot: 'bg-purple-500', badge: 'bg-purple-500/15 text-purple-400 border-purple-500/30', icon: 'bg-purple-500/20 border-purple-500/40 text-purple-400', text: 'text-purple-400', border: 'border-purple-500/40' },
  amber:  { dot: 'bg-amber-500',  badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',  icon: 'bg-amber-500/20 border-amber-500/40 text-amber-400',   text: 'text-amber-400',  border: 'border-amber-500/40' },
  indigo: { dot: 'bg-indigo-500', badge: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30', icon: 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400', text: 'text-indigo-400', border: 'border-indigo-500/40' },
  green:  { dot: 'bg-emerald-500',badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',icon:'bg-emerald-500/20 border-emerald-500/40 text-emerald-400',text: 'text-emerald-400',border:'border-emerald-500/40'},
  pink:   { dot: 'bg-pink-500',   badge: 'bg-pink-500/15 text-pink-400 border-pink-500/30',    icon: 'bg-pink-500/20 border-pink-500/40 text-pink-400',    text: 'text-pink-400',   border: 'border-pink-500/40' },
  teal:   { dot: 'bg-teal-500',   badge: 'bg-teal-500/15 text-teal-400 border-teal-500/30',    icon: 'bg-teal-500/20 border-teal-500/40 text-teal-400',    text: 'text-teal-400',   border: 'border-teal-500/40' },
}

// Status → icon + ring color
function StageIcon({ status, stageColor }: { status: PipelineStageInfo['status']; stageColor: StageColor }) {
  const c = COLOR[stageColor]
  if (status === 'done')
    return (
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400`}>
        ✓
      </div>
    )
  if (status === 'needs_action')
    return (
      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-amber-500/20 border border-amber-500/40 text-amber-400 animate-pulse">
        !
      </div>
    )
  if (status === 'active')
    return (
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0 ${c.icon} border`}>
        ●
      </div>
    )
  // locked / skipped
  return (
    <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 bg-gray-800 border border-gray-700">
      <div className="w-1.5 h-1.5 rounded-full bg-gray-600" />
    </div>
  )
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Stage row ─────────────────────────────────────────────────────────────────

function StageRow({
  stage, info, isLast, onApprove, oppId, approving,
}: {
  stage:     typeof STAGES[number]
  info:      PipelineStageInfo
  isLast:    boolean
  onApprove: (id: string) => void
  oppId:     string
  approving: boolean
}) {
  const c = COLOR[stage.color]
  const isLocked  = info.status === 'locked'
  const nameColor = isLocked ? 'text-gray-600' : info.status === 'done' ? 'text-emerald-400' : c.text

  return (
    <div className="flex items-stretch gap-0">
      {/* Vertical connector */}
      <div className="w-9 flex flex-col items-center flex-shrink-0">
        <div className="pt-3">
          <StageIcon status={info.status} stageColor={stage.color} />
        </div>
        {!isLast && <div className="flex-1 w-px bg-gray-800 mt-1" />}
      </div>

      {/* Content */}
      <div className={`flex-1 pb-3 pt-2.5 ${!isLast ? 'border-b border-gray-800/50' : ''} min-w-0`}>
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          <span className={`text-xs font-semibold ${nameColor}`}>{stage.label}</span>
          {!isLocked && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              info.status === 'done'         ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' :
              info.status === 'needs_action' ? 'bg-amber-500/10 text-amber-400 border-amber-500/25 animate-pulse' :
              info.status === 'active'       ? `${c.badge} border` :
              'text-gray-600 border-gray-800'
            }`}>
              {info.status === 'done' ? 'done' : info.status === 'needs_action' ? 'needs you' : info.status === 'active' ? 'running' : 'pending'}
            </span>
          )}
          {info.agent && !isLocked && (
            <span className="text-[10px] text-gray-600">{info.agent}</span>
          )}
          {info.date && (
            <span className="text-[10px] text-gray-600 ml-auto">{timeAgo(info.date)}</span>
          )}
        </div>

        {info.summary && (
          <p className={`text-xs mt-0.5 ${isLocked ? 'text-gray-600' : 'text-gray-400'}`}>{info.summary}</p>
        )}
        {info.detail && !isLocked && (
          <p className="text-[11px] text-gray-600 mt-0.5">{info.detail}</p>
        )}

        {/* CTAs */}
        {info.cta && !isLocked && (
          <div className="flex items-center gap-2 mt-2">
            {info.cta.action === 'approve' ? (
              <button
                onClick={() => onApprove(oppId)}
                disabled={approving}
                className="text-[11px] px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 transition disabled:opacity-50"
              >
                {approving ? 'Approving…' : info.cta.label}
              </button>
            ) : (
              <Link
                href={info.cta.href}
                className="text-[11px] px-2.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition"
              >
                {info.cta.label} →
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Opportunity card ──────────────────────────────────────────────────────────

function OppCard({ item, onApprove }: { item: JourneyItem; onApprove: (id: string) => void }) {
  const [expanded,  setExpanded]  = useState(false)
  const [approving, setApproving] = useState(false)

  const activeStage = STAGES[item.pipelineStage - 1] ?? STAGES[0]
  const c = COLOR[activeStage.color]

  // Derive current stage chip
  const chipLabel =
    item.isComplete    ? 'Complete' :
    item.needsAction   ? 'Needs you' :
    activeStage.label

  const chipClass =
    item.isComplete    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
    item.needsAction   ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse' :
    c.badge

  async function handleApprove(id: string) {
    setApproving(true)
    await onApprove(id)
    setApproving(false)
  }

  return (
    <div className={`bg-gray-900 border rounded-xl overflow-hidden transition-all ${
      expanded ? 'border-gray-700' : 'border-gray-800 hover:border-gray-700'
    }`}>
      {/* Progress bar */}
      <div className="h-0.5 bg-gray-800">
        <div
          className={`h-full transition-all ${item.isComplete ? 'bg-emerald-500' : c.dot}`}
          style={{ width: `${item.progressPct}%` }}
        />
      </div>

      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(p => !p)}
        className="w-full text-left px-4 py-3 flex items-center gap-3"
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${item.isComplete ? 'bg-emerald-500' : item.needsAction ? 'bg-amber-500' : c.dot}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{item.topic}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {item.totalSv ? `${Number(item.totalSv).toLocaleString()} SV · ` : ''}
            {item.signalCount} signal{item.signalCount !== 1 ? 's' : ''} · {timeAgo(item.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {item.tyrScore != null && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
              (item.tyrScore ?? 0) >= 80 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' :
              (item.tyrScore ?? 0) >= 60 ? 'bg-amber-500/10 text-amber-400 border-amber-500/25' :
              'bg-red-500/10 text-red-400 border-red-500/25'
            }`}>
              Tyr {item.tyrScore}
            </span>
          )}
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${chipClass}`}>
            {chipLabel}
          </span>
          <span className="text-gray-600 text-xs">{expanded ? '▾' : '▸'}</span>
        </div>
      </button>

      {/* Expanded pipeline */}
      {expanded && (
        <div className="border-t border-gray-800 px-4 py-2">
          {STAGES.map((stage, i) => (
            <StageRow
              key={stage.n}
              stage={stage}
              info={item.stages[i]}
              isLast={i === STAGES.length - 1}
              onApprove={handleApprove}
              oppId={item.id}
              approving={approving}
            />
          ))}
          <div className="flex items-center justify-end pt-1 pb-0.5">
            <Link
              href={`/command-center/opportunities`}
              className="text-[11px] text-blue-400 hover:text-blue-300 transition"
            >
              View in Opportunities →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type TabFilter = 'all' | 'needs_action' | 'in_progress' | 'completed'

interface Stats {
  total: number; needsAction: number; inProgress: number; completed: number
}

export default function PipelineJourneyPage() {
  const [items,     setItems]     = useState<JourneyItem[]>([])
  const [stats,     setStats]     = useState<Stats>({ total: 0, needsAction: 0, inProgress: 0, completed: 0 })
  const [tab,       setTab]       = useState<TabFilter>('all')
  const [loading,   setLoading]   = useState(true)
  const [search,    setSearch]    = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/pipeline-journey?site=g2g&limit=60`)
      if (!res.ok) return
      const json = await res.json()
      setItems(json.journey ?? [])
      setStats(json.stats   ?? { total: 0, needsAction: 0, inProgress: 0, completed: 0 })
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function handleApprove(oppId: string) {
    await fetch('/api/opportunities', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [oppId], status: 'brief_queued' }),
    })
    // Optimistically update
    setItems(prev => prev.map(it =>
      it.id === oppId
        ? { ...it, oppStatus: 'brief_queued',
            stages: it.stages.map((s, i) => i === 2 ? { ...s, status: 'done' as const, summary: 'Approved — queued for brief generation' } : s) }
        : it
    ))
  }

  // Filter by tab + search
  const visible = items.filter(it => {
    const tabMatch =
      tab === 'all'          ? true :
      tab === 'needs_action' ? it.needsAction :
      tab === 'in_progress'  ? (!it.needsAction && !it.isComplete) :
      tab === 'completed'    ? it.isComplete : true

    const q = search.trim().toLowerCase()
    const searchMatch = !q || it.topic.toLowerCase().includes(q)

    return tabMatch && searchMatch
  })

  const tabs: { id: TabFilter; label: string; count: number }[] = [
    { id: 'all',          label: 'All',          count: stats.total },
    { id: 'needs_action', label: 'Needs action',  count: stats.needsAction },
    { id: 'in_progress',  label: 'In progress',   count: stats.inProgress },
    { id: 'completed',    label: 'Completed',     count: stats.completed },
  ]

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Pipeline Journey</h1>
        <p className="text-sm text-gray-400 mt-1">
          Track every opportunity from detection through to measurable ranking impact.
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Total',        value: stats.total,       color: 'text-white'         },
          { label: 'Needs action', value: stats.needsAction, color: 'text-amber-400'     },
          { label: 'In progress',  value: stats.inProgress,  color: 'text-blue-400'      },
          { label: 'Completed',    value: stats.completed,   color: 'text-emerald-400'   },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
            <p className="text-xs text-gray-500 mt-1">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs + search */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-0.5 gap-0.5">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition flex items-center gap-1.5 ${
                tab === t.id
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
              {t.count > 0 && (
                <span className={`text-[10px] px-1.5 py-0 rounded-full ${
                  t.id === 'needs_action' && t.count > 0
                    ? 'bg-amber-500/20 text-amber-400'
                    : 'bg-gray-700 text-gray-400'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search topics…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-0 max-w-xs bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-gray-600"
        />
        <button
          onClick={fetchData}
          className="text-xs text-gray-500 hover:text-gray-300 border border-gray-800 px-3 py-1.5 rounded-lg transition"
        >
          ↻ Refresh
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-600">
          <div className="w-6 h-6 border-2 border-gray-700 border-t-gray-400 rounded-full animate-spin mb-3" />
          <p className="text-sm">Loading pipeline…</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🎯</p>
          <p className="text-white font-semibold mb-1">
            {items.length === 0 ? 'No opportunities yet' : 'No matching opportunities'}
          </p>
          <p className="text-gray-500 text-sm">
            {items.length === 0
              ? 'Run detection agents (Heimdall, Loki, Odin) to surface opportunities.'
              : 'Try a different filter or search term.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(item => (
            <OppCard key={item.id} item={item} onApprove={handleApprove} />
          ))}
          {visible.length < items.length && (
            <p className="text-center text-xs text-gray-600 py-2">
              Showing {visible.length} of {items.length} opportunities
            </p>
          )}
        </div>
      )}
    </div>
  )
}
