'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  closestCorners, type DragStartEvent, type DragOverEvent, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ── Types ─────────────────────────────────────────────────────────────────────
export type CampaignGoals = {
  traffic_goal?: number; traffic_period?: 'monthly' | 'weekly'
  ranking_goal?: number; ranking_keywords?: string[]
  brief_completion_target?: number; custom?: string
}

export type CampaignPage = {
  id: string; page_url: string; action_item_id: string | null
  position: number; notes: string | null; status: PageStatus; eta: string | null
}

export type Campaign = {
  id: string; name: string; description: string | null; color: string
  position: number; goals: CampaignGoals; gsc_site_url: string | null
  parent_campaign_id: string | null; created_at: string; updated_at: string
  campaign_pages: CampaignPage[]; status: CampaignStatus
  campaign_notes: string | null
}

export type CampaignComment = {
  id: string; author_email: string; content: string; created_at: string
}

type CampaignStatus = 'not_started' | 'in_progress' | 'completed' | 'paused'
type PageStatus     = 'not_started' | 'in_progress' | 'done'

type CampaignGroup = { parent: Campaign; children: Campaign[] }

// ── Constants ─────────────────────────────────────────────────────────────────
const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316','#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6']

const CAMPAIGN_STATUS: Record<CampaignStatus, { label: string; color: string; dot: string }> = {
  not_started: { label: 'Not started', color: 'text-gray-400', dot: 'bg-gray-500' },
  in_progress: { label: 'In progress', color: 'text-yellow-400', dot: 'bg-yellow-400' },
  completed:   { label: 'Completed',   color: 'text-green-400',  dot: 'bg-green-400' },
  paused:      { label: 'Paused',      color: 'text-orange-400', dot: 'bg-orange-400' },
}

const PAGE_STATUS: Record<PageStatus, { label: string; color: string; bg: string }> = {
  not_started: { label: 'Not started', color: 'text-gray-500',  bg: 'bg-gray-700' },
  in_progress: { label: 'In progress', color: 'text-yellow-400', bg: 'bg-yellow-500' },
  done:        { label: 'Done',        color: 'text-green-400',  bg: 'bg-green-500' },
}

function shortUrl(url: string) {
  try {
    const u = new URL(url)
    return u.pathname === '/' ? u.hostname : u.pathname.replace(/\/$/, '')
  } catch { return url }
}

function colorBg(hex: string) { return hex + '18' }

function initials(email: string) {
  return (email.split('@')[0]?.[0] ?? '?').toUpperCase()
}

function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Grouping ──────────────────────────────────────────────────────────────────
function buildGroups(campaigns: Campaign[]): CampaignGroup[] {
  const allIds = new Set(campaigns.map(c => c.id))
  // Top-level: no parent, OR parent not in current list
  const topLevel = campaigns
    .filter(c => !c.parent_campaign_id || !allIds.has(c.parent_campaign_id))
    .sort((a, b) => a.position - b.position)

  return topLevel.map(parent => ({
    parent,
    children: campaigns
      .filter(c => c.parent_campaign_id === parent.id)
      .sort((a, b) => a.position - b.position),
  }))
}

// ── PageCard detail panel (comments + notes + status + ETA) ───────────────────
function PageCardDetail({
  page,
  campaignId,
  onClose,
  onUpdate,
}: {
  page: CampaignPage
  campaignId: string
  onClose: () => void
  onUpdate: (pageId: string, updates: Partial<CampaignPage>) => void
}) {
  const [notes, setNotes]         = useState(page.notes ?? '')
  const [status, setStatus]       = useState<PageStatus>(page.status)
  const [eta, setEta]             = useState(page.eta ?? '')
  const [comments, setComments]   = useState<CampaignComment[]>([])
  const [loadingComments, setLoadingComments] = useState(true)
  const [commentInput, setCommentInput]       = useState('')
  const [submitting, setSubmitting]           = useState(false)
  const [saving, setSaving]                   = useState(false)

  // Load comments on mount
  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/pages/${page.id}/comments`)
      .then(r => r.json())
      .then(d => setComments(d.comments ?? []))
      .finally(() => setLoadingComments(false))
  }, [campaignId, page.id])

  async function saveField(field: 'notes' | 'status' | 'eta', value: string | null) {
    setSaving(true)
    const body: Record<string, string | null> = { [field]: value }
    await fetch(`/api/campaigns/${campaignId}/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    onUpdate(page.id, { [field]: value } as Partial<CampaignPage>)
    setSaving(false)
  }

  async function submitComment() {
    const text = commentInput.trim()
    if (!text) return
    setSubmitting(true)
    const res = await fetch(`/api/campaigns/${campaignId}/pages/${page.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    })
    const data = await res.json()
    if (data.comment) {
      setComments(prev => [...prev, data.comment])
      setCommentInput('')
    }
    setSubmitting(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <p className="text-gray-400 text-xs mb-1 font-mono">{shortUrl(page.page_url)}</p>
            <a href={page.page_url} target="_blank" rel="noopener noreferrer"
              className="text-white text-sm hover:underline truncate block" title={page.page_url}>
              {page.page_url}
            </a>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 flex-shrink-0">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Status + ETA row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1.5">Status</label>
              <select
                value={status}
                onChange={e => {
                  setStatus(e.target.value as PageStatus)
                  saveField('status', e.target.value)
                }}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                {(Object.entries(PAGE_STATUS) as [PageStatus, { label: string }][]).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1.5">ETA</label>
              <input
                type="date"
                value={eta}
                onChange={e => setEta(e.target.value)}
                onBlur={e => saveField('eta', e.target.value || null)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs text-gray-500 mb-1.5">
              Notes {saving && <span className="text-gray-600">· saving…</span>}
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={e => saveField('notes', e.target.value || null)}
              rows={3}
              placeholder="Add notes about this page…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          {/* Comments */}
          <div>
            <label className="block text-xs text-gray-500 mb-3">
              Comments {!loadingComments && comments.length > 0 && `(${comments.length})`}
            </label>
            {loadingComments ? (
              <p className="text-gray-600 text-xs">Loading…</p>
            ) : (
              <div className="space-y-3 mb-3">
                {comments.length === 0 && (
                  <p className="text-gray-600 text-xs">No comments yet.</p>
                )}
                {comments.map(c => (
                  <div key={c.id} className="flex gap-3">
                    <div className="w-7 h-7 rounded-full bg-indigo-700 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                      {initials(c.author_email)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-xs font-medium text-gray-300 truncate max-w-[140px]" title={c.author_email}>
                          {c.author_email.split('@')[0]}
                        </span>
                        <span className="text-gray-600 text-xs flex-shrink-0">{relativeTime(c.created_at)}</span>
                      </div>
                      <p className="text-sm text-gray-300 leading-relaxed">{c.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Add comment */}
            <div className="flex gap-2">
              <input
                value={commentInput}
                onChange={e => setCommentInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment() } }}
                placeholder="Add a comment…"
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={submitComment}
                disabled={submitting || !commentInput.trim()}
                className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm transition"
              >
                {submitting ? '…' : '↑'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── PageCard ──────────────────────────────────────────────────────────────────
function PageCard({
  page, campaignId, color,
  onRemove, onExpand, isDragOverlay = false,
}: {
  page: CampaignPage; campaignId: string; color: string
  onRemove: (campaignId: string, pageId: string) => void
  onExpand: (page: CampaignPage, campaignId: string) => void
  isDragOverlay?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: page.id, data: { type: 'page', campaignId } })

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }
  const ps = PAGE_STATUS[page.status]

  return (
    <div
      ref={setNodeRef}
      style={isDragOverlay ? {} : style}
      className={`group bg-gray-800 border rounded-lg ${isDragOverlay ? 'shadow-2xl ring-2 ring-indigo-500 border-gray-600' : 'border-gray-700 hover:border-gray-600'}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {/* drag handle */}
        <span
          className="text-gray-600 text-xs select-none flex-shrink-0 cursor-grab active:cursor-grabbing"
          {...(isDragOverlay ? {} : { ...attributes, ...listeners })}
        >⠿</span>

        {/* status dot */}
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${ps.bg}`} title={ps.label} />

        {/* URL — click to open detail */}
        <button
          className="flex-1 text-left text-gray-200 truncate font-mono text-xs hover:text-white"
          title={page.page_url}
          onClick={() => !isDragOverlay && onExpand(page, campaignId)}
        >
          {shortUrl(page.page_url)}
        </button>

        {/* ETA badge */}
        {page.eta && !isDragOverlay && (
          <span className="flex-shrink-0 text-xs text-gray-500 bg-gray-900 px-1.5 py-0.5 rounded border border-gray-700">
            {page.eta.slice(5)}
          </span>
        )}

        {/* Notes indicator */}
        {page.notes && !isDragOverlay && (
          <span className="flex-shrink-0 text-gray-600 text-xs" title="Has notes">📝</span>
        )}

        {!isDragOverlay && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(campaignId, page.id) }}
            className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity text-xs px-0.5"
            title="Remove from campaign"
          >✕</button>
        )}
      </div>
    </div>
  )
}

// ── CampaignColumn ────────────────────────────────────────────────────────────
function CampaignColumn({
  campaign, allCampaigns,
  onRemovePage, onAddPage, onEdit, onDelete, onUpdatePage, onExpandPage,
  onUpdateCampaign,
  isDragOverlay = false,
}: {
  campaign: Campaign; allCampaigns: Campaign[]
  onRemovePage: (campaignId: string, pageId: string) => void
  onAddPage: (campaignId: string, url: string) => Promise<void>
  onEdit: (c: Campaign) => void
  onDelete: (id: string) => void
  onUpdatePage: (pageId: string, updates: Partial<CampaignPage>) => void
  onExpandPage: (page: CampaignPage, campaignId: string) => void
  onUpdateCampaign: (id: string, updates: Partial<Campaign>) => void
  isDragOverlay?: boolean
}) {
  const [addingUrl, setAddingUrl]   = useState(false)
  const [urlInput, setUrlInput]     = useState('')
  const [addError, setAddError]     = useState('')
  const [showNotes, setShowNotes]   = useState(false)
  const [notesText, setNotesText]   = useState(campaign.campaign_notes ?? '')
  const [editingStatus, setEditingStatus] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (addingUrl) inputRef.current?.focus() }, [addingUrl])

  const pageIds = campaign.campaign_pages.slice().sort((a, b) => a.position - b.position).map(p => p.id)
  const cs = CAMPAIGN_STATUS[campaign.status as CampaignStatus] ?? CAMPAIGN_STATUS.not_started

  // Goals chips
  const g = campaign.goals ?? {}
  const goalChips: string[] = []
  if (g.traffic_goal)            goalChips.push(`🎯 ${g.traffic_goal.toLocaleString()}/${g.traffic_period ?? 'mo'}`)
  if (g.ranking_goal)            goalChips.push(`📍 ≤pos ${g.ranking_goal}`)
  if (g.brief_completion_target) goalChips.push(`📝 ${g.brief_completion_target}%`)
  if (g.custom)                  goalChips.push(`💬 ${g.custom.slice(0, 25)}${g.custom.length > 25 ? '…' : ''}`)

  const parent = allCampaigns.find(c => c.id === campaign.parent_campaign_id)

  async function submitUrl() {
    const url = urlInput.trim(); if (!url) return
    setAddError('')
    try { await onAddPage(campaign.id, url); setUrlInput(''); setAddingUrl(false) }
    catch (err: unknown) { setAddError(err instanceof Error ? err.message : String(err)) }
  }

  return (
    <div className={`flex flex-col w-72 flex-shrink-0 bg-gray-900 border rounded-xl overflow-hidden ${isDragOverlay ? 'shadow-2xl ring-2 ring-indigo-500 border-gray-600' : 'border-gray-800'}`}>
      {/* Header */}
      <div className="px-4 pt-3 pb-2" style={{ background: colorBg(campaign.color), borderBottom: `2px solid ${campaign.color}` }}>
        <div className="flex items-start gap-2">
          <span className="w-3 h-3 rounded-full flex-shrink-0 mt-0.5" style={{ background: campaign.color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-white text-sm truncate">{campaign.name}</span>
              <span className="text-xs text-gray-400 flex-shrink-0 ml-auto">{campaign.campaign_pages.length}</span>
            </div>
            {parent && <p className="text-xs text-gray-500 mt-0.5 truncate">↳ {parent.name}</p>}
            {campaign.description && (
              <p className="text-xs text-gray-400 mt-0.5 truncate" title={campaign.description}>{campaign.description}</p>
            )}
          </div>
          {!isDragOverlay && (
            <div className="flex gap-1 flex-shrink-0 -mt-0.5" onClick={e => e.stopPropagation()}>
              <button onPointerDown={e => e.stopPropagation()} onClick={() => onEdit(campaign)} className="text-gray-500 hover:text-gray-300 text-xs px-1 py-0.5 rounded" title="Edit">✎</button>
              <button onPointerDown={e => e.stopPropagation()} onClick={() => onDelete(campaign.id)} className="text-gray-500 hover:text-red-400 text-xs px-1 py-0.5 rounded" title="Delete">✕</button>
            </div>
          )}
        </div>

        {/* Status row */}
        <div className="flex items-center gap-2 mt-2 ml-5">
          {editingStatus && !isDragOverlay ? (
            <select
              autoFocus
              value={campaign.status}
              onBlur={() => setEditingStatus(false)}
              onChange={e => {
                onUpdateCampaign(campaign.id, { status: e.target.value as CampaignStatus })
                setEditingStatus(false)
              }}
              className="text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-white focus:outline-none"
            >
              {(Object.entries(CAMPAIGN_STATUS) as [CampaignStatus, { label: string }][]).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          ) : (
            <button
              onClick={() => !isDragOverlay && setEditingStatus(true)}
              className="flex items-center gap-1.5 text-xs hover:opacity-80 transition"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${cs.dot}`} />
              <span className={cs.color}>{cs.label}</span>
            </button>
          )}
          <button
            onClick={() => setShowNotes(n => !n)}
            className="ml-auto text-gray-600 hover:text-gray-400 text-xs transition"
            title="Toggle notes"
          >
            📝
          </button>
        </div>

        {/* Campaign notes (collapsible) */}
        {showNotes && !isDragOverlay && (
          <div className="mt-2 ml-5">
            <textarea
              value={notesText}
              onChange={e => setNotesText(e.target.value)}
              onBlur={e => onUpdateCampaign(campaign.id, { campaign_notes: e.target.value || null })}
              rows={2}
              placeholder="Campaign notes…"
              className="w-full bg-gray-900/80 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>
        )}

        {/* Goal chips */}
        {goalChips.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2 ml-5">
            {goalChips.map((chip, i) => (
              <span key={i} className="text-xs bg-gray-800/80 text-gray-400 rounded-full px-2 py-0.5 border border-gray-700/50">{chip}</span>
            ))}
          </div>
        )}
      </div>

      {/* Pages list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 min-h-[60px]">
        <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
          {campaign.campaign_pages
            .slice().sort((a, b) => a.position - b.position)
            .map(page => (
              <PageCard
                key={page.id} page={page} campaignId={campaign.id} color={campaign.color}
                onRemove={onRemovePage} onExpand={onExpandPage}
              />
            ))}
        </SortableContext>
        {campaign.campaign_pages.length === 0 && !addingUrl && (
          <p className="text-center text-gray-600 text-xs py-4">Drop pages here</p>
        )}
      </div>

      {/* Add page */}
      <div className="px-3 pb-3">
        {addingUrl ? (
          <div className="space-y-1">
            <input ref={inputRef} value={urlInput} onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submitUrl(); if (e.key === 'Escape') { setAddingUrl(false); setUrlInput('') } }}
              placeholder="https://g2g.com/page"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
            {addError && <p className="text-red-400 text-xs">{addError}</p>}
            <div className="flex gap-2">
              <button onClick={submitUrl} className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg py-1.5 transition">Add</button>
              <button onClick={() => { setAddingUrl(false); setUrlInput(''); setAddError('') }} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg py-1.5 transition">Cancel</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAddingUrl(true)}
            className="w-full text-gray-500 hover:text-gray-300 hover:bg-gray-800 text-xs rounded-lg py-1.5 transition border border-dashed border-gray-700 hover:border-gray-600">
            + Add page
          </button>
        )}
      </div>
    </div>
  )
}

// ── Campaign modal (create / edit) ────────────────────────────────────────────
const COLORS_LIST = COLORS

function CampaignModal({ initial, allCampaigns, onSave, onClose }: {
  initial?: Partial<Campaign>; allCampaigns: Campaign[]
  onSave: (data: Partial<Campaign>) => Promise<void>; onClose: () => void
}) {
  const [name,    setName]    = useState(initial?.name ?? '')
  const [desc,    setDesc]    = useState(initial?.description ?? '')
  const [color,   setColor]   = useState(initial?.color ?? '#6366f1')
  const [parent,  setParent]  = useState(initial?.parent_campaign_id ?? '')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')
  const g = initial?.goals ?? {}
  const [trafficGoal,   setTrafficGoal]   = useState(String(g.traffic_goal ?? ''))
  const [trafficPeriod, setTrafficPeriod] = useState<'monthly'|'weekly'>(g.traffic_period ?? 'monthly')
  const [rankingGoal,   setRankingGoal]   = useState(String(g.ranking_goal ?? ''))
  const [rankingKws,    setRankingKws]    = useState((g.ranking_keywords ?? []).join(', '))
  const [briefTarget,   setBriefTarget]   = useState(String(g.brief_completion_target ?? ''))
  const [customGoal,    setCustomGoal]    = useState(g.custom ?? '')

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true); setError('')
    try {
      const goals: CampaignGoals = {}
      if (trafficGoal)  { goals.traffic_goal = Number(trafficGoal); goals.traffic_period = trafficPeriod }
      if (rankingGoal)  goals.ranking_goal = Number(rankingGoal)
      if (rankingKws)   goals.ranking_keywords = rankingKws.split(',').map(k => k.trim()).filter(Boolean)
      if (briefTarget)  goals.brief_completion_target = Number(briefTarget)
      if (customGoal)   goals.custom = customGoal.trim()
      await onSave({ name: name.trim(), description: desc.trim() || null, color, parent_campaign_id: parent || null, goals } as Partial<Campaign>)
      onClose()
    } catch (err: unknown) { setError(err instanceof Error ? err.message : String(err)); setSaving(false) }
  }

  const others = allCampaigns.filter(c => c.id !== initial?.id)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-white font-semibold text-lg">{initial?.id ? 'Edit Campaign' : 'New Campaign'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Campaign name *</label>
            <input value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="e.g. Q2 SEO Push"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Color</label>
            <div className="flex gap-2 flex-wrap">
              {COLORS_LIST.map(c => (
                <button key={c} onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-offset-gray-900 ring-white scale-110' : ''}`}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} placeholder="Optional…"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none" />
          </div>
          {others.length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Parent campaign</label>
              <select value={parent} onChange={e => setParent(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500">
                <option value="">— None —</option>
                {others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {/* Goals */}
          <div className="border border-gray-800 rounded-xl p-4 space-y-3">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Goals (optional)</p>
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">🎯 Traffic goal (clicks)</label>
                <input type="number" value={trafficGoal} onChange={e => setTrafficGoal(e.target.value)} placeholder="5000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Period</label>
                <select value={trafficPeriod} onChange={e => setTrafficPeriod(e.target.value as 'monthly'|'weekly')}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none">
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">📍 Avg position goal (≤)</label>
              <input type="number" value={rankingGoal} onChange={e => setRankingGoal(e.target.value)} placeholder="5"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Keywords to track (comma-separated)</label>
              <input value={rankingKws} onChange={e => setRankingKws(e.target.value)} placeholder="buy game, sell game"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">📝 Brief completion target (%)</label>
              <input type="number" min="0" max="100" value={briefTarget} onChange={e => setBriefTarget(e.target.value)} placeholder="80"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">💬 Custom goal</label>
              <input value={customGoal} onChange={e => setCustomGoal(e.target.value)} placeholder="e.g. Increase revenue from organic by 20%"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500" />
            </div>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-3 pt-1">
            <button onClick={handleSave} disabled={saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-xl py-2.5 text-sm transition">
              {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create campaign'}
            </button>
            <button onClick={onClose} className="px-6 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2.5 text-sm transition">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main KanbanBoard ──────────────────────────────────────────────────────────
export default function CampaignKanban({ initial }: { initial: Campaign[] }) {
  const [campaigns, setCampaigns]         = useState<Campaign[]>([...initial].sort((a, b) => a.position - b.position))
  const [activeId, setActiveId]           = useState<string | null>(null)
  const [activeType, setActiveType]       = useState<'page' | null>(null)
  const [showModal, setShowModal]         = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | undefined>()
  const [deletingId, setDeletingId]       = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [expandedPage, setExpandedPage]   = useState<{ page: CampaignPage; campaignId: string } | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // ── Helpers ────────────────────────────────────────────────────────────────
  function findPageCampaign(pageId: string) {
    return campaigns.find(c => c.campaign_pages.some(p => p.id === pageId))
  }
  function findPage(pageId: string) {
    for (const c of campaigns) { const p = c.campaign_pages.find(p => p.id === pageId); if (p) return p }
    return null
  }

  // ── DnD ────────────────────────────────────────────────────────────────────
  function onDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
    setActiveType((active.data.current as { type: string })?.type === 'page' ? 'page' : null)
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || active.id === over.id) return
    if ((active.data.current as { type: string })?.type !== 'page') return
    const sourceCampaign = findPageCampaign(active.id as string)
    if (!sourceCampaign) return
    const overType = (over.data.current as { type: string })?.type
    const targetCampaignId = overType === 'campaign'
      ? over.id as string
      : findPageCampaign(over.id as string)?.id ?? null
    if (!targetCampaignId || targetCampaignId === sourceCampaign.id) return
    setCampaigns(prev => {
      const next = prev.map(c => ({ ...c, campaign_pages: [...c.campaign_pages] }))
      const src = next.find(c => c.id === sourceCampaign.id)!
      const tgt = next.find(c => c.id === targetCampaignId)!
      const page = src.campaign_pages.find(p => p.id === active.id)!
      src.campaign_pages = src.campaign_pages.filter(p => p.id !== active.id)
      tgt.campaign_pages = [...tgt.campaign_pages, { ...page, position: tgt.campaign_pages.length }]
      return next
    })
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    setActiveId(null); setActiveType(null)
    if (!over || (active.data.current as { type: string })?.type !== 'page') return
    const sourceCampaign = findPageCampaign(active.id as string)
    if (!sourceCampaign) return
    fetch(`/api/campaigns/${sourceCampaign.id}/pages`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: active.id, target_campaign_id: sourceCampaign.id }),
    })
  }

  // ── Campaign CRUD ──────────────────────────────────────────────────────────
  async function createCampaign(data: Partial<Campaign>) {
    const res = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed')
    setCampaigns(prev => [...prev, { ...json.campaign, campaign_pages: [], status: 'not_started', campaign_notes: null }])
  }

  async function updateCampaign(data: Partial<Campaign>) {
    const id = editingCampaign!.id
    const res = await fetch(`/api/campaigns/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed')
    setCampaigns(prev => prev.map(c => c.id === id ? { ...c, ...data } : c))
  }

  const updateCampaignInline = useCallback((id: string, updates: Partial<Campaign>) => {
    setCampaigns(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c))
    fetch(`/api/campaigns/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
    })
  }, [])

  async function confirmDelete() {
    if (!deletingId) return
    setDeleteLoading(true)
    const res = await fetch(`/api/campaigns/${deletingId}`, { method: 'DELETE' })
    if (res.ok) setCampaigns(prev => prev.filter(c => c.id !== deletingId))
    setDeletingId(null); setDeleteLoading(false)
  }

  const addPageRef = useRef<((campaignId: string, url: string) => Promise<void>) | null>(null)
  addPageRef.current = useCallback(async (campaignId: string, url: string) => {
    const res = await fetch(`/api/campaigns/${campaignId}/pages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_url: url }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed to add page')
    setCampaigns(prev => prev.map(c =>
      c.id === campaignId ? { ...c, campaign_pages: [...c.campaign_pages, { ...json.page, notes: null, status: 'not_started', eta: null }] } : c
    ))
  }, [])

  async function removePage(campaignId: string, pageId: string) {
    const res = await fetch(`/api/campaigns/${campaignId}/pages`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page_id: pageId }),
    })
    if (res.ok) setCampaigns(prev => prev.map(c =>
      c.id === campaignId ? { ...c, campaign_pages: c.campaign_pages.filter(p => p.id !== pageId) } : c
    ))
  }

  const updatePage = useCallback((pageId: string, updates: Partial<CampaignPage>) => {
    setCampaigns(prev => prev.map(c => ({
      ...c,
      campaign_pages: c.campaign_pages.map(p => p.id === pageId ? { ...p, ...updates } : p),
    })))
    // Also update expandedPage if it matches
    setExpandedPage(prev => prev && prev.page.id === pageId ? { ...prev, page: { ...prev.page, ...updates } } : prev)
  }, [])

  const groups = buildGroups(campaigns)
  const allPageIds = campaigns.flatMap(c => c.campaign_pages.map(p => p.id))

  const activePage = activeType === 'page' ? findPage(activeId!) : null
  const activePageCampaign = activePage ? findPageCampaign(activeId!) : null

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-6 border-b border-gray-800 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Campaigns</h1>
          <p className="text-gray-400 text-sm mt-1">Drag pages between campaigns · Click a card to add notes, ETA, and comments</p>
        </div>
        <button onClick={() => { setEditingCampaign(undefined); setShowModal(true) }}
          className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl px-4 py-2 text-sm transition">
          + New Campaign
        </button>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-x-auto px-8 py-6">
        {campaigns.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center">
            <div>
              <div className="text-5xl mb-4">🎯</div>
              <h2 className="text-white font-semibold text-lg mb-2">No campaigns yet</h2>
              <p className="text-gray-400 text-sm mb-6 max-w-xs">Create your first campaign to start grouping pages into focused initiatives.</p>
              <button onClick={() => setShowModal(true)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl px-6 py-2.5 text-sm transition">
                + New Campaign
              </button>
            </div>
          </div>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCorners}
            onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
            <SortableContext items={allPageIds} strategy={verticalListSortingStrategy}>
              <div className="flex gap-5 items-start pb-4">
                {groups.map(group => (
                  <div
                    key={group.parent.id}
                    className={`flex gap-3 flex-shrink-0 ${
                      group.children.length > 0
                        ? 'bg-gray-950 border border-gray-800 rounded-2xl p-3'
                        : ''
                    }`}
                  >
                    {/* Parent campaign column */}
                    <div>
                      {group.children.length > 0 && (
                        <p className="text-xs text-gray-600 font-medium mb-2 px-1">Parent</p>
                      )}
                      <CampaignColumn
                        campaign={group.parent}
                        allCampaigns={campaigns}
                        onRemovePage={removePage}
                        onAddPage={(...args) => addPageRef.current!(...args)}
                        onEdit={c => { setEditingCampaign(c); setShowModal(true) }}
                        onDelete={setDeletingId}
                        onUpdatePage={updatePage}
                        onExpandPage={(page, campaignId) => setExpandedPage({ page, campaignId })}
                        onUpdateCampaign={updateCampaignInline}
                      />
                    </div>
                    {/* Child campaign columns */}
                    {group.children.length > 0 && (
                      <div className="flex gap-3">
                        <div className="w-px bg-gray-800 self-stretch mx-1" />
                        {group.children.map(child => (
                          <div key={child.id}>
                            <p className="text-xs text-gray-600 font-medium mb-2 px-1">Sub-campaign</p>
                            <CampaignColumn
                              campaign={child}
                              allCampaigns={campaigns}
                              onRemovePage={removePage}
                              onAddPage={(...args) => addPageRef.current!(...args)}
                              onEdit={c => { setEditingCampaign(c); setShowModal(true) }}
                              onDelete={setDeletingId}
                              onUpdatePage={updatePage}
                              onExpandPage={(page, campaignId) => setExpandedPage({ page, campaignId })}
                              onUpdateCampaign={updateCampaignInline}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {/* Add campaign shortcut */}
                <button onClick={() => { setEditingCampaign(undefined); setShowModal(true) }}
                  className="flex-shrink-0 w-72 h-24 rounded-xl border-2 border-dashed border-gray-800 hover:border-gray-600 text-gray-600 hover:text-gray-400 flex items-center justify-center gap-2 text-sm transition">
                  + New Campaign
                </button>
              </div>
            </SortableContext>
            <DragOverlay>
              {activePage && activePageCampaign && (
                <PageCard page={activePage} campaignId={activePageCampaign.id} color={activePageCampaign.color}
                  onRemove={() => {}} onExpand={() => {}} isDragOverlay />
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Page detail panel */}
      {expandedPage && (
        <PageCardDetail
          page={expandedPage.page}
          campaignId={expandedPage.campaignId}
          onClose={() => setExpandedPage(null)}
          onUpdate={updatePage}
        />
      )}

      {/* Delete confirm */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-white font-semibold mb-2">Delete campaign?</h3>
            <p className="text-gray-400 text-sm mb-4">All pages will be removed. This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeletingId(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2 text-sm">Cancel</button>
              <button onClick={confirmDelete} disabled={deleteLoading} className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl py-2 text-sm">
                {deleteLoading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <CampaignModal
          initial={editingCampaign} allCampaigns={campaigns}
          onSave={editingCampaign ? updateCampaign : createCampaign}
          onClose={() => { setShowModal(false); setEditingCampaign(undefined) }}
        />
      )}
    </div>
  )
}
