'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'

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

export type BriefSummary = {
  brief_id: string
  status: 'generating' | 'draft' | 'reviewed' | 'published'
  brief_type: 'on_page' | 'off_page'
  // off-page idea counts
  blog_count: number
  forum_count: number
  social_count: number
  draft_count: number
  // on-page
  content_draft_words: number
}

// legacy alias — page.tsx passes briefStatuses but we now expect briefSummaries
export type BriefStatus = Pick<BriefSummary, 'status' | 'brief_type'>

export type Pagination = {
  page: number
  limit: number
  total: number
  totalPages: number
  from: string
  to: string
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

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

function avatarColor(email: string) {
  const colors = ['bg-indigo-600','bg-purple-600','bg-pink-600','bg-rose-600','bg-orange-600','bg-teal-600','bg-cyan-600','bg-blue-600']
  let hash = 0
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[hash]
}

// ─── Assignee Popover ─────────────────────────────────────────────────────────
function AssigneePopover({ item, currentUserEmail, workspaceMembers, onAssigned, onClose }: {
  item: ActionItem
  currentUserEmail: string
  workspaceMembers: { email: string; role: string }[]
  onAssigned: (email: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [manualEmail, setManualEmail] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [onClose])

  async function assign(email: string) {
    if (!email) return
    setSaving(true)
    try {
      const res = await fetch('/api/actions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, assigned_to: email }),
      })
      if (!res.ok) throw new Error('Failed')
      onAssigned(email)
      onClose()
    } catch {
      alert('Failed to assign')
    } finally {
      setSaving(false)
    }
  }

  // All members to show — current user first, then others (excluding duplicates)
  const otherMembers = workspaceMembers.filter(m => m.email !== currentUserEmail)

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-1 z-30 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl p-3 w-64"
    >
      <p className="text-xs text-gray-400 mb-2 font-medium">Assign to</p>

      {/* Current user */}
      {currentUserEmail && (
        <button
          onClick={() => assign(currentUserEmail)}
          disabled={saving}
          className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-gray-700 text-gray-200 transition mb-1 flex items-center gap-2 disabled:opacity-50"
        >
          <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
            {initials(currentUserEmail)}
          </span>
          <span className="truncate">{currentUserEmail.split('@')[0]}</span>
          <span className="ml-auto text-gray-500 text-[10px] flex-shrink-0">me</span>
        </button>
      )}

      {/* Workspace members */}
      {otherMembers.map(m => (
        <button
          key={m.email}
          onClick={() => assign(m.email)}
          disabled={saving}
          className="w-full text-left text-xs px-3 py-2 rounded-lg hover:bg-gray-700 text-gray-200 transition mb-1 flex items-center gap-2 disabled:opacity-50"
        >
          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0 ${avatarColor(m.email)}`}>
            {initials(m.email)}
          </span>
          <span className="truncate">{m.email.split('@')[0]}</span>
          {m.role === 'manager' && (
            <span className="ml-auto text-purple-400 text-[10px] flex-shrink-0">mgr</span>
          )}
        </button>
      ))}

      {/* Manual email fallback */}
      <div className="mt-2 border-t border-gray-700 pt-2">
        <input
          type="email"
          placeholder="Other email…"
          value={manualEmail}
          onChange={e => setManualEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && assign(manualEmail)}
          className="w-full text-xs bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-red-600 mb-1.5"
        />
        <button
          onClick={() => assign(manualEmail)}
          disabled={!manualEmail || saving}
          className="w-full text-xs bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2 py-1.5 rounded-lg transition"
        >
          {saving ? 'Saving…' : 'Assign'}
        </button>
      </div>
    </div>
  )
}

// ─── Brief Preview (expandable inline) ───────────────────────────────────────
function BriefPreviewSection({ summary }: { summary: BriefSummary }) {
  if (summary.brief_type === 'on_page') {
    const statusLabel =
      summary.status === 'reviewed'  ? '★ Reviewed' :
      summary.status === 'published' ? '↗ Published' : '✓ Ready for review'
    const statusCls =
      summary.status === 'reviewed'  ? 'text-blue-300 border-blue-600 bg-blue-600/10' :
      summary.status === 'published' ? 'text-purple-300 border-purple-600 bg-purple-600/10' :
                                       'text-green-300 border-green-600 bg-green-600/10'
    return (
      <div className="mt-3 pt-3 border-t border-gray-700/50 flex items-center gap-4 flex-wrap">
        <span className="text-xs text-gray-400">
          📝 Draft:{' '}
          <span className="text-white font-medium">
            {summary.content_draft_words > 0 ? `~${summary.content_draft_words.toLocaleString()} words` : '—'}
          </span>
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusCls}`}>
          {statusLabel}
        </span>
      </div>
    )
  }

  // Off-page
  const total = summary.blog_count + summary.forum_count + summary.social_count
  return (
    <div className="mt-3 pt-3 border-t border-gray-700/50 flex items-center gap-4 flex-wrap">
      {summary.blog_count > 0 && (
        <span className="text-xs text-gray-400">
          📝 Blog: <span className="text-white font-medium">{summary.blog_count}</span>
        </span>
      )}
      {summary.forum_count > 0 && (
        <span className="text-xs text-gray-400">
          💬 Forum: <span className="text-white font-medium">{summary.forum_count}</span>
        </span>
      )}
      {summary.social_count > 0 && (
        <span className="text-xs text-gray-400">
          📱 Social: <span className="text-white font-medium">{summary.social_count}</span>
        </span>
      )}
      {summary.draft_count > 0 && (
        <span className="text-xs text-gray-500">
          ({summary.draft_count} drafted)
        </span>
      )}
      {total === 0 && (
        <span className="text-xs text-gray-500">Ideas not generated yet</span>
      )}
      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
        summary.status === 'reviewed'  ? 'text-blue-300 border-blue-600 bg-blue-600/10' :
        summary.status === 'published' ? 'text-purple-300 border-purple-600 bg-purple-600/10' :
                                          'text-green-300 border-green-600 bg-green-600/10'
      }`}>
        {summary.status === 'reviewed' ? '★ Reviewed' : summary.status === 'published' ? '↗ Published' : '✓ Draft'}
      </span>
    </div>
  )
}

// ─── Add Item Modal ───────────────────────────────────────────────────────────
function AddItemModal({ onAdded, onClose }: {
  onAdded: (item: ActionItem) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState('')
  const [actionType, setActionType] = useState<'on_page' | 'off_page'>('on_page')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) { setError('URL is required'); return }
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: url.trim(), action_type: actionType, notes: notes.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      onAdded(json.item as ActionItem)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div ref={ref} className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-800">
          <h2 className="text-white font-semibold text-base">Add Action Item</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition text-lg leading-none">✕</button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-4">
          {/* URL */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Page URL <span className="text-red-400">*</span></label>
            <input
              type="text"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://g2g.com/categories/... or /categories/..."
              autoFocus
              className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
          </div>

          {/* Action type */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Action Type</label>
            <div className="grid grid-cols-2 gap-2">
              {(['on_page', 'off_page'] as const).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setActionType(type)}
                  className={`px-3 py-2.5 rounded-xl border text-sm font-medium transition ${
                    actionType === type
                      ? type === 'on_page'
                        ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                        : 'bg-purple-600/20 border-purple-500 text-purple-300'
                      : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                  }`}
                >
                  {type === 'on_page' ? '✏️ On-Page' : '📣 Off-Page'}
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Notes <span className="text-gray-600">(optional)</span></label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="Why is this page being added? Any context..."
              className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 focus:border-transparent resize-none"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 text-sm px-4 py-2.5 rounded-xl border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !url.trim()}
              className="flex-1 text-sm px-4 py-2.5 rounded-xl bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium transition"
            >
              {saving ? 'Adding…' : 'Add Item'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Main Table ───────────────────────────────────────────────────────────────
type Filter = 'all' | ActionItem['status'] | ActionItem['action_type']

export function ActionItemsTable({
  items: initialItems,
  briefSummaries: initialBriefSummaries,
  currentUserEmail,
  workspaceMembers = [],
  pagination,
}: {
  items: ActionItem[]
  briefSummaries: Record<string, BriefSummary>
  currentUserEmail: string
  workspaceMembers?: { email: string; role: string }[]
  pagination: Pagination
}) {
  const router   = useRouter()
  const pathname = usePathname()

  const [items, setItems] = useState(initialItems)
  const [briefSummaries, setBriefSummaries] = useState(initialBriefSummaries)
  const [filter, setFilter] = useState<Filter>('all')
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all') // 'all' | email | 'unassigned'

  // Date range local state (mirrors URL but editable before applying)
  const [fromInput, setFromInput] = useState(pagination.from)
  const [toInput,   setToInput]   = useState(pagination.to)

  function navigate(params: Partial<{ page: number; limit: number; from: string; to: string }>) {
    const p = new URLSearchParams()
    const next = {
      page:  pagination.page,
      limit: pagination.limit,
      from:  pagination.from,
      to:    pagination.to,
      ...params,
    }
    if (next.page  > 1)    p.set('page',  String(next.page))
    if (next.limit !== 20) p.set('limit', String(next.limit))
    if (next.from)         p.set('from',  next.from)
    if (next.to)           p.set('to',    next.to)
    router.push(`${pathname}${p.toString() ? '?' + p.toString() : ''}`)
  }

  function applyDateFilter() {
    navigate({ from: fromInput, to: toInput, page: 1 })
  }

  function clearDateFilter() {
    setFromInput('')
    setToInput('')
    navigate({ from: '', to: '', page: 1 })
  }
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [editingNotes, setEditingNotes] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())
  const [bulkGenerating, setBulkGenerating] = useState(false)
  const [assigneePopoverId, setAssigneePopoverId] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)

  const filtered = items.filter(item => {
    const matchesType =
      filter === 'all' ||
      item.status === filter ||
      item.action_type === filter
    const matchesAssignee =
      assigneeFilter === 'all' ||
      (assigneeFilter === 'unassigned' ? !item.assigned_to : item.assigned_to === assigneeFilter)
    return matchesType && matchesAssignee
  })

  // Unique assignees from ALL items on this page (for the dropdown)
  const assignees = Array.from(
    new Set(items.map(i => i.assigned_to).filter((a): a is string => !!a))
  ).sort()
  const hasUnassignedInProgress = items.some(i => i.status === 'in_progress' && !i.assigned_to)

  const counts = {
    all: items.length,
    pending: items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    done: items.filter(i => i.status === 'done').length,
  }

  const briefCounts = {
    total: Object.keys(briefSummaries).length,
    reviewed: Object.values(briefSummaries).filter(b => b.status === 'reviewed').length,
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleExpand(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function pollBriefStatus(itemId: string, briefId: string) {
    const poll = async () => {
      try {
        const res = await fetch(`/api/brief/generate?id=${briefId}`)
        if (!res.ok) return
        const brief = await res.json()

        if (brief.status === 'generating') {
          setTimeout(poll, 3000)
          return
        }

        // Brief done — build summary
        const ideas = (brief.content_ideas ?? []) as Array<{ content_type: string; draft?: string }>
        setBriefSummaries(prev => ({
          ...prev,
          [itemId]: {
            brief_id: briefId,
            status: brief.status,
            brief_type: brief.brief_type,
            blog_count:   ideas.filter(i => i.content_type === 'blog_post').length,
            forum_count:  ideas.filter(i => i.content_type === 'forum').length,
            social_count: ideas.filter(i => i.content_type === 'social').length,
            draft_count:  ideas.filter(i => i.draft).length,
            content_draft_words: brief.content_draft
              ? (brief.content_draft as string).split(/\s+/).filter(Boolean).length
              : 0,
          },
        }))
        setGeneratingIds(prev => {
          const next = new Set(prev)
          next.delete(itemId)
          return next
        })
      } catch {
        // silently retry
        setTimeout(poll, 5000)
      }
    }
    setTimeout(poll, 3000)
  }

  async function generateBrief(item: ActionItem, config?: Record<string, { enabled: boolean; count: number }>) {
    setGeneratingIds(prev => new Set(prev).add(item.id))
    try {
      const res = await fetch('/api/brief/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action_item_id: item.id,
          ...(config ? { content_type_config: config } : {}),
        }),
      })
      if (!res.ok) throw new Error('Generate failed')
      const { brief_id } = await res.json()

      // Optimistic update
      setBriefSummaries(prev => ({
        ...prev,
        [item.id]: {
          brief_id,
          status: 'generating',
          brief_type: item.action_type,
          blog_count: 0, forum_count: 0, social_count: 0, draft_count: 0, content_draft_words: 0,
        },
      }))

      pollBriefStatus(item.id, brief_id)
    } catch {
      alert('Failed to generate brief. Please try again.')
      setGeneratingIds(prev => {
        const next = new Set(prev)
        next.delete(item.id)
        return next
      })
    }
  }

  async function bulkGenerate() {
    const toGenerate = [...selectedIds]
      .map(id => items.find(i => i.id === id))
      .filter((item): item is ActionItem => !!item && !generatingIds.has(item.id) && briefSummaries[item.id]?.status !== 'generating')

    if (toGenerate.length === 0) {
      setSelectedIds(new Set())
      return
    }

    setBulkGenerating(true)
    for (const item of toGenerate) {
      const alreadyHasBrief = !!briefSummaries[item.id]
      if (alreadyHasBrief) continue // skip items that already have a brief

      // off-page: minimal config (1 blog + 1 forum); on-page: default
      const config = item.action_type === 'off_page'
        ? { blog_post: { enabled: true, count: 1 }, forum: { enabled: true, count: 1 }, social: { enabled: false, count: 0 } }
        : undefined

      await generateBrief(item, config)
      await new Promise(r => setTimeout(r, 300)) // short gap between requests
    }
    setBulkGenerating(false)
    setSelectedIds(new Set())
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
      setItems(prev => prev.map(i => i.id === item.id ? { ...i, notes: notesDraft } : i))
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

  // How many selected items still need a brief
  const noBriefCount = [...selectedIds].filter(id =>
    !generatingIds.has(id) && !briefSummaries[id]
  ).length

  return (
    <>
      {/* ── Add Item Modal ───────────────────────────────────────────────────── */}
      {showAddModal && (
        <AddItemModal
          onAdded={item => setItems(prev => [item, ...prev])}
          onClose={() => setShowAddModal(false)}
        />
      )}

      {/* ── Top bar: summary strip + Add Item button ─────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs text-gray-500">
          {pagination.total.toLocaleString()} item{pagination.total !== 1 ? 's' : ''} total
          {(pagination.from || pagination.to) && (
            <span className="ml-1 text-gray-600">
              · filtered by date
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {/* Export CSV */}
          <a
            href={`/api/actions/export${pagination.from || pagination.to
              ? '?' + new URLSearchParams(
                  Object.fromEntries([
                    pagination.from ? ['from', pagination.from] : [],
                    pagination.to   ? ['to',   pagination.to]   : [],
                  ].filter(e => e.length > 0) as [string, string][])
                ).toString()
              : ''}`}
            download
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition"
            title="Export all items as CSV"
          >
            ↓ Export CSV
          </a>
          <button
            onClick={() => setShowAddModal(true)}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 text-white transition"
          >
            <span className="text-base leading-none">+</span> Add Item
          </button>
        </div>
      </div>

      {/* ── Summary strip ───────────────────────────────────────────────────── */}
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

      {/* ── Filter tabs + date range + limit ─────────────────────────────── */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
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

      {/* ── Assignee filter ───────────────────────────────────────────────── */}
      {(assignees.length > 0 || hasUnassignedInProgress) && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-xs text-gray-500">Assignee:</span>
          <button
            onClick={() => setAssigneeFilter('all')}
            className={`text-xs px-3 py-1 rounded-full border transition ${
              assigneeFilter === 'all'
                ? 'bg-gray-700 border-gray-600 text-white'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
            }`}
          >
            All
          </button>
          {hasUnassignedInProgress && (
            <button
              onClick={() => setAssigneeFilter('unassigned')}
              className={`text-xs px-3 py-1 rounded-full border transition ${
                assigneeFilter === 'unassigned'
                  ? 'bg-yellow-700/40 border-yellow-600 text-yellow-300'
                  : 'border-yellow-700/30 text-yellow-600 hover:border-yellow-600 hover:text-yellow-400'
              }`}
            >
              ⚠ Unassigned
            </button>
          )}
          {assignees.map(email => (
            <button
              key={email}
              onClick={() => setAssigneeFilter(email)}
              className={`text-xs px-3 py-1 rounded-full border transition inline-flex items-center gap-1.5 ${
                assigneeFilter === email
                  ? 'bg-indigo-700/40 border-indigo-600 text-indigo-200'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
            >
              <span className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                {initials(email)}
              </span>
              {email.split('@')[0]}
            </button>
          ))}
        </div>
      )}

      {/* ── Date range + limit selector row ──────────────────────────────── */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Date range */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Snapshot date:</span>
          <input
            type="date"
            value={fromInput}
            onChange={e => setFromInput(e.target.value)}
            className="text-xs bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:ring-1 focus:ring-red-600 focus:border-red-600"
          />
          <span className="text-xs text-gray-600">—</span>
          <input
            type="date"
            value={toInput}
            onChange={e => setToInput(e.target.value)}
            className="text-xs bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none focus:ring-1 focus:ring-red-600 focus:border-red-600"
          />
          <button
            onClick={applyDateFilter}
            disabled={!fromInput && !toInput}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition disabled:opacity-40"
          >
            Apply
          </button>
          {(pagination.from || pagination.to) && (
            <button
              onClick={clearDateFilter}
              className="text-xs text-gray-500 hover:text-gray-300 transition"
            >
              ✕ Clear
            </button>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Per-page limit + total count */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-600">
            {pagination.total.toLocaleString()} total ·
          </span>
          <span className="text-xs text-gray-500">Show:</span>
          {[20, 50, 100].map(n => (
            <button
              key={n}
              onClick={() => navigate({ limit: n, page: 1 })}
              className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                pagination.limit === n
                  ? 'bg-gray-700 border-gray-600 text-white'
                  : 'border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* ── Floating bulk action bar ───────────────────────────────────────── */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-gray-900 border border-gray-600 rounded-2xl px-5 py-3 shadow-2xl">
          <span className="text-sm text-gray-300 font-medium">
            {selectedIds.size} selected
          </span>
          <div className="w-px h-4 bg-gray-700" />
          <button
            onClick={bulkGenerate}
            disabled={bulkGenerating || noBriefCount === 0}
            className="text-xs font-semibold px-4 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition"
          >
            {bulkGenerating
              ? '⚙️ Generating…'
              : noBriefCount === 0
              ? 'All have briefs'
              : `⚡ Generate Brief (${noBriefCount})`}
          </button>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-xs text-gray-500 hover:text-gray-300 transition"
          >
            Clear
          </button>
        </div>
      )}

      {/* ── Items list ─────────────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
          <p className="text-gray-400 text-sm">No items match this filter.</p>
          {counts.all === 0 && (
            <p className="text-gray-500 text-xs mt-2">
              Select pages from{' '}
              <a href="/gsc/ranking-drop" className="text-blue-400 underline">Ranking Drop Alert</a>{' '}
              and assign an action to get started.
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
            const isSelected = selectedIds.has(item.id)
            const isExpanded = expandedIds.has(item.id)
            const summary = briefSummaries[item.id]
            const isGenerating = generatingIds.has(item.id) || summary?.status === 'generating'
            const hasBrief = !!summary && summary.status !== 'generating'

            return (
              <div
                key={item.id}
                className={`bg-gray-900 border rounded-xl p-4 transition ${
                  isSelected
                    ? 'border-red-700/50 ring-1 ring-red-700/30'
                    : item.status === 'done'
                    ? 'border-gray-800 opacity-70'
                    : 'border-gray-700'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Checkbox */}
                  <label className="mt-1 flex-shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(item.id)}
                      className="accent-red-600 w-4 h-4"
                    />
                  </label>

                  {/* Left: page info */}
                  <div className="flex-1 min-w-0">
                    {/* Badges row */}
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${at.color}`}>
                        {at.icon} {at.label}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${st.color}`}>
                        {st.label}
                      </span>
                      {/* Manual badge — items without ranking drop data were manually added */}
                      {item.clicks_drop === null && item.position_change === null && (
                        <span className="text-xs text-teal-400 bg-teal-500/10 border border-teal-500/20 px-2 py-0.5 rounded-full">
                          ✋ Manual
                        </span>
                      )}
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
                      {/* Assignee — unified for all statuses */}
                      <div className="relative">
                        <button
                          onClick={() => setAssigneePopoverId(prev => prev === item.id ? null : item.id)}
                          className={`inline-flex items-center gap-1.5 text-xs border px-2 py-0.5 rounded-full transition ${
                            item.assigned_to
                              ? 'text-gray-300 bg-gray-800 border-gray-700 hover:border-gray-500'
                              : item.status === 'in_progress'
                              ? 'text-yellow-500 bg-yellow-500/10 border-yellow-500/30 hover:border-yellow-400'
                              : 'text-gray-600 border-gray-800 border-dashed hover:border-gray-600 hover:text-gray-400'
                          }`}
                          title={item.assigned_to ? `Assigned to ${item.assigned_to} — click to change` : 'Click to assign'}
                        >
                          {item.assigned_to ? (
                            <>
                              <span className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0">
                                {initials(item.assigned_to)}
                              </span>
                              {item.assigned_to.split('@')[0]}
                            </>
                          ) : item.status === 'in_progress' ? (
                            <>
                              <span className="w-4 h-4 rounded-full bg-gray-700 flex items-center justify-center text-[9px] text-gray-400 flex-shrink-0">?</span>
                              Unassigned
                            </>
                          ) : (
                            <span className="text-gray-600">+ assign</span>
                          )}
                        </button>
                        {assigneePopoverId === item.id && (
                          <AssigneePopover
                            item={item}
                            currentUserEmail={currentUserEmail}
                            workspaceMembers={workspaceMembers}
                            onAssigned={email => {
                              setItems(prev => prev.map(i =>
                                i.id === item.id ? { ...i, assigned_to: email } : i
                              ))
                            }}
                            onClose={() => setAssigneePopoverId(null)}
                          />
                        )}
                      </div>
                    </div>

                    {/* URL row + expand toggle */}
                    <div className="flex items-center gap-2">
                      <a
                        href={item.page}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-sm font-medium truncate"
                        title={item.page}
                      >
                        {path}
                      </a>
                      {hasBrief && (
                        <button
                          onClick={() => toggleExpand(item.id)}
                          className="text-gray-600 hover:text-gray-400 text-xs transition flex-shrink-0"
                          title={isExpanded ? 'Collapse brief summary' : 'Expand brief summary'}
                        >
                          {isExpanded ? '▲' : '▼'}
                        </button>
                      )}
                    </div>

                    {/* Expanded brief summary */}
                    {isExpanded && hasBrief && (
                      <BriefPreviewSection summary={summary} />
                    )}

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

                  {/* Right: 3-button column */}
                  <div className="flex flex-col gap-2 flex-shrink-0 min-w-[110px]">

                    {/* Button 1: Generate Brief / Generating / Regenerate */}
                    {isGenerating ? (
                      <span className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-yellow-600 bg-yellow-600/10 text-yellow-300 text-center whitespace-nowrap animate-pulse">
                        ⚙️ Generating…
                      </span>
                    ) : hasBrief ? (
                      <button
                        onClick={() => generateBrief(item)}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-300 transition text-center whitespace-nowrap"
                        title="Re-generate brief"
                      >
                        ↺ Regenerate
                      </button>
                    ) : (
                      <button
                        onClick={() => generateBrief(item)}
                        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-700 bg-red-700/20 text-red-300 hover:bg-red-700 hover:text-white transition text-center whitespace-nowrap"
                      >
                        {at.icon} Generate Brief
                      </button>
                    )}

                    {/* Button 2: Details (links to brief page) */}
                    <a
                      href={`/gsc/action-items/${item.id}`}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition text-center whitespace-nowrap ${
                        hasBrief
                          ? summary.status === 'reviewed'
                            ? 'border-blue-600 bg-blue-600/10 text-blue-300 hover:bg-blue-700 hover:text-white'
                            : summary.status === 'published'
                            ? 'border-purple-600 bg-purple-600/10 text-purple-300 hover:bg-purple-700 hover:text-white'
                            : 'border-green-600 bg-green-600/10 text-green-300 hover:bg-green-700 hover:text-white'
                          : 'border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-200'
                      }`}
                    >
                      {hasBrief
                        ? summary.status === 'reviewed' ? '★ Details'
                        : summary.status === 'published' ? '↗ Details'
                        : '✓ Details'
                        : 'Details'}
                    </a>

                    {/* Button 3: Status advance */}
                    <button
                      onClick={() => advanceStatus(item)}
                      disabled={isUpdating}
                      className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition disabled:opacity-50 text-center whitespace-nowrap ${
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

      {/* ── Pagination controls ───────────────────────────────────────────── */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-800">
          <p className="text-xs text-gray-500">
            Showing {((pagination.page - 1) * pagination.limit) + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total.toLocaleString()} items
          </p>
          <div className="flex items-center gap-1">
            <button
              onClick={() => navigate({ page: 1 })}
              disabled={pagination.page === 1}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              «
            </button>
            <button
              onClick={() => navigate({ page: pagination.page - 1 })}
              disabled={pagination.page === 1}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              ← Prev
            </button>

            {/* Page number buttons — show a window around current page */}
            {Array.from({ length: pagination.totalPages }, (_, i) => i + 1)
              .filter(p =>
                p === 1 ||
                p === pagination.totalPages ||
                Math.abs(p - pagination.page) <= 2
              )
              .reduce<(number | '…')[]>((acc, p, idx, arr) => {
                if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('…')
                acc.push(p)
                return acc
              }, [])
              .map((p, idx) =>
                p === '…' ? (
                  <span key={`ellipsis-${idx}`} className="text-xs text-gray-600 px-1">…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => navigate({ page: p as number })}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition ${
                      p === pagination.page
                        ? 'bg-red-700 border-red-600 text-white'
                        : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                    }`}
                  >
                    {p}
                  </button>
                )
              )}

            <button
              onClick={() => navigate({ page: pagination.page + 1 })}
              disabled={pagination.page === pagination.totalPages}
              className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              Next →
            </button>
            <button
              onClick={() => navigate({ page: pagination.totalPages })}
              disabled={pagination.page === pagination.totalPages}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition"
            >
              »
            </button>
          </div>
        </div>
      )}
    </>
  )
}
