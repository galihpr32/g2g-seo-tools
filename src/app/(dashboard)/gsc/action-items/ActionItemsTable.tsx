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

type Filter = 'all' | ActionItem['status'] | ActionItem['action_type']

export function ActionItemsTable({ items: initialItems }: { items: ActionItem[] }) {
  const [items, setItems] = useState(initialItems)
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
          ? { ...i, status: nextStatus, completed_at: nextStatus === 'done' ? new Date().toISOString() : null }
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
      {/* Summary strip */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-2xl font-bold text-white">{counts.all}</p>
          <p className="text-gray-400 text-sm mt-0.5">Total items</p>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
          <p className="text-2xl font-bold text-yellow-400">{counts.pending}</p>
          <p className="text-gray-400 text-sm mt-0.5">Pending</p>
        </div>
        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
          <p className="text-2xl font-bold text-blue-400">{counts.in_progress}</p>
          <p className="text-gray-400 text-sm mt-0.5">In Progress</p>
        </div>
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4">
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
                    {/* Brief link */}
                    <a
                      href={`/gsc/action-items/${item.id}`}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-700 bg-red-700/20 text-red-300 hover:bg-red-700 hover:text-white transition text-center"
                    >
                      {item.action_type === 'on_page' ? '✏️ Brief' : '📣 Brief'}
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
