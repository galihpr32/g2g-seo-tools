'use client'

import { useState } from 'react'

export type ActionItem = {
  id: string
  page: string
  action_type: 'on_page' | 'off_page'
  status: 'pending' | 'in_progress' | 'done'
  notes: string | null
  snapshot_date: string
  clicks_drop: number | null
  position_change: number | null
  created_at: string
  completed_at: string | null
  assigned_to: string | null
}

export type BriefStatus = {
  status: 'generating' | 'draft' | 'reviewed' | 'published'
  brief_type: 'on_page' | 'off_page'
}

const ACTION_LABELS: Record<ActionItem['action_type'], { label: string; icon: string; color: string }> = {
  on_page:  { label: 'On-Page',  icon: '✏️', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  off_page: { label: 'Off-Page', icon: '📣', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
}

const STATUS_CONFIG: Record<ActionItem['status'], { label: string; next: ActionItem['status']; color: string; nextLabel: string }> = {
  pending:     { label: 'Pending',     next: 'in_progress', color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', nextLabel: 'Start →' },
  in_progress: { label: 'In Progress', next: 'done',        color: 'text-blue-400 bg-blue-500/10 border-blue-500/20',       nextLabel: 'Mark Done ✓' },
  done:        { label: 'Done',        next: 'pending',     color: 'text-green-400 bg-green-500/10 border-green-500/20',    nextLabel: 'Reopen' },
}

// Brief status badge shown on the Brief button
const BRIEF_STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  generating: { label: '⚙️ Generating…', cls: 'border-yellow-600 bg-yellow-600/10 text-yellow-300' },
  draft:      { label: '✓ Brief',         cls: 'border-green-600 bg-green-600/10 text-green-300 hover:bg-green-700 hover:text-white' },
  reviewed:   { label: '★ Brief',         cls: 'border-blue-600 bg-blue-600/10 text-blue-300 hover:bg-blue-700 hover:text-white' },
  published:  { label: '↗ Brief',         cls: 'border-purple-600 bg-purple-600/10 text-purple-300 hover:bg-purple-700 hover:text-white' },
}

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || email[0]?.toUpperCase() ?? '?'
}

type Filter = 'all' | ActionItem['status'] | ActionItem['action_type']

export function ActionItemsTable({
  items: initialItems,
  briefStatuses,
  currentUserEmail,
}: {
  items: ActionItem[]
  briefStatuses: Record<string, BriefStatus>
  currentUserEmail: string
}) {
  const [items, setItems] = useState(initialItems)
  const [localBriefStatuses, setLocalBriefStatuses] = useState(briefStatuses)
  const [filter, setFilter] = useState<Filter>('all')
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')

  const filtered = items.filter(item => {
    if (filter === 'all') return true
    return item.status === filter || item.action_type === filter
  })

  const counts = {
    all: items.length,
    pending: items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    done: items.filter(i => i.status === 'done').length,
  }

  const briefCounts = {
    total: Object.keys(localBriefStatuses).length,
    draft: Object.values(localBriefStatuses).filter(b => b.status === 'draft').length,
    reviewed: Object.values(localBriefStatuses).filter(b => b.status === 'reviewed').length,
  }

  async function advanceStatus(item: ActionItem) {
    const nextStatus = STATUS_CONFIG[item.status].next
    setUpdatingId(item.id)
    try {
      const res = await fetch('/api/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, status: nextStatus }),
      })
      if (!res.ok) throw new Error('Failed')
      setItems(prev => prev.map(i =>
        i.id === item.id
          ? {
              ...i,
              status: nextStatus,
              completed_at: nextStatus === 'done' ? new Date().toISOString() : null,
              // Auto-assign on in_progress if not yet assigned
              assigned_to: nextStatus === 'in_progress' && !i.assigned_to ? currentUserEmail : i.assigned_to,
            }
          : i
      ))
    } catch {
      alert('Failed to update status')
    } finally {
      setUpdatingId(null)
    }
  }

  async function saveNotes(item: ActionItem) {
    try {
      const res = await fetch('/api/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, notes: notesDraft }),
      })
      if (!res.ok) throw new Error('Failed')
      setItems(prev => prev.map(i =>
        i.id === item.id ? { ...i, notes: notesDraft } : i
      ))
      setEditingNotes(null)
    } catch {
      alert('Failed to save notes')
    }
  }

  const FILTER_TABS: { key: Filter; label: string }[] = [
    { key: 'all',         label: `All (${counts.all})` },
    { key: 'pending',     label: `Pending (${counts.pending})` },
    { key: 'in_progress', label: `In Progress (${counts.in_progress})` },
    { key: 'done',        label: `Done (${counts.done})` },
    { key: 'on_page',     label: 'On-Page' },
    { key: 'off_page',    label: 'Off-Page' },
  ]

  return (
    <>
      {/* ── Summary strip (clickable to filter) ──────────────────────────── */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div
          onClick={() => setFilter('all')}
          className={`bg-gray-900 border rounded-xl p-4 cursor-pointer transition hover:border-gray-600 ${filter === 'all' ? 'border-gray-500 ring-1 ring-gray-500' : 'border-gray-800'}`}
        >
          <p className="text-2xl font-bold text-white">{counts.all}</p>
          <p className="text-gray-400 text-sm mt-0.5">Total items</p>
          {briefCounts.total > 0 && (
            <p className="text-gray-600 text-xs mt-1">
              {briefCounts.total} brief{briefCounts.total > 1 ? 's' : ''} generated
              {briefCounts.reviewed > 0 && ` · ${briefCounts.reviewed} reviewed`}
            </p>
          )}
        </div>
        <div
          onClick={() => setFilter('pending')}
          className={`bg-yellow-500/10 border rounded-xl p-4 cursor-pointer transition hover:border-yellow-400/40 ${filter === 'pending' ? 'border-yellow-400/60 ring-1 ring-yellow-500/40' : 'border-yellow-500/20'}`}
        >
          <p className="text-2xl font-bold text-yellow-400">{counts.pending}</p>
          <p className="text-gray-400 text-sm mt-0.5">Pending</p>
        </div>
        <div
          onClick={() => setFilter('in_progress')}
          className={`bg-blue-500/10 border rounded-xl p-4 cursor-pointer transition hover:border-blue-400/40 ${filter === 'in_progress' ? 'border-blue-400/60 ring-1 ring-blue-500/40' : 'border-blue-500/20'}`}
        >
          <p className="text-2xl font-bold text-blue-400">{counts.in_progress}</p>
          <p className="text-gray-400 text-sm mt-0.5">In Progress</p>
        </div>
        <div
          onClick={() => setFilter('done')}
          className={`bg-green-500/10 border rounded-xl p-4 cursor-pointer transition hover:border-green-400/40 ${filter === 'done' ? 'border-green-400/60 ring-1 ring-green-500/40' : 'border-green-500/20'}`}
        >
          <p className="text-2xl font-bold text-green-400">{counts.done}</p>
          <p className="text-gray-400 text-sm mt-0.5">Done</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition font-medium ${
              filter === tab.key
                ? 'bg-red-700 border-red-600 text-white'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
          <p className="text-gray-400 text-sm">No items match this filter.</p>
          {counts.all === 0 && (
            <p className="text-gray-500 text-xs mt-2">
              Select pages from <a href="/gsc/ranking-drop" className="text-blue-400 underline">Ranking Drop Alert</a> and assign an action to get started.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(item => {
            let path = item.page
            try { path = new URL(item.page).pathname } catch { /* keep */ }
            const st = STATUS_CONFIG[item.status]
            const at = ACTION_LABELS[item.action_type]
            const isUpdating = updatingId === item.id
            const isEditingNotes = editingNotes === item.id
            const briefInfo = localBriefStatuses[item.id]
            const briefStyle = briefInfo ? (BRIEF_STATUS_STYLE[briefInfo.status] ?? BRIEF_STATUS_STYLE.draft) : null

            return (
              <div
                key={item.id}
                className={`bg-gray-900 border rounded-xl p-4 transition ${
                  item.status === 'done' ? 'border-gray-800 opacity-70' : 'border-gray-700'
                }`}
              >
                <div className="flex items-start gap-4">
                  {/* Left: page info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      {/* Action type badge */}
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${at.color}`}>
                        {at.icon} {at.label}
                      </span>
                      {/* Status badge */}
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${st.color}`}>
                        {st.label}
                      </span>
                      {/* Drop context */}
                      {item.clicks_drop !== null && item.clicks_drop > 0 && (
                        <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">
                          -{Math.round(item.clicks_drop * 100)}% clicks
                        </span>
                      )}
                      {item.position_change !== null && item.position_change >= 5 && (
                        <span className="text-xs text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full">
                          +{item.position_change.toFixed(1)} pos
                        </span>
                      )}
                      {/* Assignee badge */}
                      {item.assigned_to && (
                        <span
                          className="inline-flex items-center gap-1.5 text-xs text-gray-300 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-full"
                          title={item.assigned_to}
                        >
                          <span className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                            {initials(item.assigned_to)}
                          </span>
                          {item.assigned_to.split('@')[0]}
                        </span>
                      )}
                    </div>

                    {/* URL */}
                    <a
                      href={item.page}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 text-sm font-medium truncate block"
                      title={item.page}
                    >
                      {path}
                    </a>

                    {/* Notes */}
                    <div className="mt-2">
                      {isEditingNotes ? (
                        <div className="flex items-end gap-2">
                          <textarea
                            value={notesDraft}
                            onChange={e => setNotesDraft(e.target.value)}
                            rows={2}
                            autoFocus
                            className="flex-1 bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-red-600"
                            placeholder="Add notes..."
                          />
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => saveNotes(item)}
                              className="text-xs bg-green-700 hover:bg-green-600 text-white px-3 py-1 rounded-lg transition"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingNotes(null)}
                              className="text-xs text-gray-500 hover:text-gray-300 px-3 py-1"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingNotes(item.id); setNotesDraft(item.notes ?? '') }}
                          className="text-left text-xs text-gray-500 hover:text-gray-300 transition"
                        >
                          {item.notes ? (
                            <span className="text-gray-400">{item.notes}</span>
                          ) : (
                            <span className="italic">+ add notes</span>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Meta */}
                    <p className="text-xs text-gray-600 mt-2">
                      Added {new Date(item.created_at).toLocaleDateString('id-ID')}
                      {' · '}from snapshot {item.snapshot_date}
                      {item.completed_at && (
                        <> · Done {new Date(item.completed_at).toLocaleDateString('id-ID')}</>
                      )}
                    </p>
                  </div>

                  {/* Right: buttons */}
                  <div className="flex flex-col gap-2 flex-shrink-0">
                    {/* Brief link — shows status if brief exists, default if not */}
                    <a
                      href={`/gsc/action-items/${item.id}`}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition text-center whitespace-nowrap ${
                        briefStyle
                          ? briefInfo.status === 'generating'
                            ? 'border-yellow-600 bg-yellow-600/10 text-yellow-300 pointer-events-none'
                            : briefStyle.cls
                          : 'border-red-700 bg-red-700/20 text-red-300 hover:bg-red-700 hover:text-white'
                      }`}
                    >
                      {briefStyle ? briefStyle.label : (item.action_type === 'on_page' ? '✏️ Brief' : '📣 Brief')}
                    </a>
                    {/* Status advance */}
                    <button
                      onClick={() => advanceStatus(item)}
                      disabled={isUpdating}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition disabled:opacity-50 ${
                        item.status === 'done'
                          ? 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300'
                          : item.status === 'in_progress'
                          ? 'bg-green-700 hover:bg-green-600 border-green-600 text-white'
                          : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
                      }`}
                    >
                      {isUpdating ? '…' : st.nextLabel}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
