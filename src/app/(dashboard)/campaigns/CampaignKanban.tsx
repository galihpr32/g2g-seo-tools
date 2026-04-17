'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ── Types ─────────────────────────────────────────────────────────────────────

export type CampaignGoals = {
  traffic_goal?: number
  traffic_period?: 'monthly' | 'weekly'
  ranking_goal?: number
  ranking_keywords?: string[]
  brief_completion_target?: number
  custom?: string
}

export type CampaignPage = {
  id: string
  page_url: string
  action_item_id: string | null
  position: number
}

export type Campaign = {
  id: string
  name: string
  description: string | null
  color: string
  position: number
  goals: CampaignGoals
  gsc_site_url: string | null
  parent_campaign_id: string | null
  created_at: string
  campaign_pages: CampaignPage[]
}

// ── Colour palette ────────────────────────────────────────────────────────────
const COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6',
]

function colorBg(hex: string) {
  return hex + '22'   // 13% opacity
}

// ── Utility: shorten URL for display ─────────────────────────────────────────
function shortUrl(url: string) {
  try {
    const u = new URL(url)
    return (u.pathname === '/' ? u.hostname : u.pathname).replace(/\/$/, '')
  } catch {
    return url
  }
}

// ── PageCard (sortable) ───────────────────────────────────────────────────────
function PageCard({
  page,
  campaignId,
  color,
  onRemove,
  isDragOverlay = false,
}: {
  page: CampaignPage
  campaignId: string
  color: string
  onRemove: (campaignId: string, pageId: string) => void
  isDragOverlay?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: page.id, data: { type: 'page', campaignId } })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={isDragOverlay ? {} : style}
      className={`group flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm cursor-grab active:cursor-grabbing ${isDragOverlay ? 'shadow-2xl ring-2 ring-indigo-500' : 'hover:border-gray-600'}`}
      {...attributes}
      {...listeners}
    >
      <span className="text-gray-400 text-xs select-none">⠿</span>
      <span className="flex-1 text-gray-200 truncate font-mono text-xs" title={page.page_url}>
        {shortUrl(page.page_url)}
      </span>
      {!isDragOverlay && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(campaignId, page.id) }}
          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 transition-opacity text-xs px-1"
          title="Remove from campaign"
        >
          ✕
        </button>
      )}
    </div>
  )
}

// ── CampaignColumn (sortable column) ─────────────────────────────────────────
function CampaignColumn({
  campaign,
  allCampaigns,
  onRemovePage,
  onAddPage,
  onEdit,
  onDelete,
  isDragOverlay = false,
}: {
  campaign: Campaign
  allCampaigns: Campaign[]
  onRemovePage: (campaignId: string, pageId: string) => void
  onAddPage: (campaignId: string, url: string) => void
  onEdit: (campaign: Campaign) => void
  onDelete: (campaignId: string) => void
  isDragOverlay?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: campaign.id, data: { type: 'campaign' } })

  const [addingUrl, setAddingUrl] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [addError, setAddError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (addingUrl) inputRef.current?.focus()
  }, [addingUrl])

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  const pageIds = campaign.campaign_pages
    .slice()
    .sort((a, b) => a.position - b.position)
    .map(p => p.id)

  const goals = campaign.goals ?? {}
  const goalChips: string[] = []
  if (goals.traffic_goal)              goalChips.push(`🎯 ${goals.traffic_goal.toLocaleString()} clicks/${goals.traffic_period ?? 'mo'}`)
  if (goals.ranking_goal)              goalChips.push(`📍 pos ≤${goals.ranking_goal}`)
  if (goals.brief_completion_target)   goalChips.push(`📝 ${goals.brief_completion_target}% briefs`)
  if (goals.custom)                    goalChips.push(`💬 ${goals.custom.slice(0, 30)}${goals.custom.length > 30 ? '…' : ''}`)

  const parent = allCampaigns.find(c => c.id === campaign.parent_campaign_id)

  async function submitUrl() {
    const url = urlInput.trim()
    if (!url) return
    setAddError('')
    try {
      await onAddPage(campaign.id, url)
      setUrlInput('')
      setAddingUrl(false)
    } catch (err: unknown) {
      setAddError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={isDragOverlay ? {} : style}
      className={`flex flex-col w-72 flex-shrink-0 bg-gray-900 border rounded-xl overflow-hidden ${isDragOverlay ? 'shadow-2xl ring-2 ring-indigo-500' : 'border-gray-800'}`}
    >
      {/* Column header */}
      <div
        className="flex items-start gap-2 px-4 py-3 cursor-grab active:cursor-grabbing"
        style={{ background: colorBg(campaign.color), borderBottom: `2px solid ${campaign.color}` }}
        {...(isDragOverlay ? {} : { ...attributes, ...listeners })}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-full flex-shrink-0"
              style={{ background: campaign.color }}
            />
            <span className="font-semibold text-white text-sm truncate">{campaign.name}</span>
            <span className="ml-auto text-xs text-gray-400 flex-shrink-0">
              {campaign.campaign_pages.length}
            </span>
          </div>
          {parent && (
            <div className="text-xs text-gray-500 mt-0.5 truncate pl-5">
              ↳ {parent.name}
            </div>
          )}
          {campaign.description && (
            <p className="text-xs text-gray-400 mt-1 pl-5 truncate" title={campaign.description}>
              {campaign.description}
            </p>
          )}
          {goalChips.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2 pl-5">
              {goalChips.map((chip, i) => (
                <span key={i} className="text-xs bg-gray-800 text-gray-300 rounded-full px-2 py-0.5 border border-gray-700">
                  {chip}
                </span>
              ))}
            </div>
          )}
        </div>
        {!isDragOverlay && (
          <div className="flex gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onEdit(campaign)}
              className="text-gray-500 hover:text-gray-300 text-xs px-1 py-0.5 rounded"
              title="Edit campaign"
            >
              ✎
            </button>
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onDelete(campaign.id)}
              className="text-gray-500 hover:text-red-400 text-xs px-1 py-0.5 rounded"
              title="Delete campaign"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Pages list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[80px]">
        <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
          {campaign.campaign_pages
            .slice()
            .sort((a, b) => a.position - b.position)
            .map(page => (
              <PageCard
                key={page.id}
                page={page}
                campaignId={campaign.id}
                color={campaign.color}
                onRemove={onRemovePage}
              />
            ))}
        </SortableContext>

        {campaign.campaign_pages.length === 0 && !addingUrl && (
          <p className="text-center text-gray-600 text-xs py-4">
            Drop pages here
          </p>
        )}
      </div>

      {/* Add page input */}
      <div className="px-3 pb-3">
        {addingUrl ? (
          <div className="space-y-1">
            <input
              ref={inputRef}
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submitUrl()
                if (e.key === 'Escape') { setAddingUrl(false); setUrlInput('') }
              }}
              placeholder="https://g2g.com/page"
              className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
            {addError && <p className="text-red-400 text-xs">{addError}</p>}
            <div className="flex gap-2">
              <button
                onClick={submitUrl}
                className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white text-xs rounded-lg py-1.5 transition"
              >
                Add
              </button>
              <button
                onClick={() => { setAddingUrl(false); setUrlInput(''); setAddError('') }}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg py-1.5 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setAddingUrl(true)}
            className="w-full text-gray-500 hover:text-gray-300 hover:bg-gray-800 text-xs rounded-lg py-1.5 transition border border-dashed border-gray-700 hover:border-gray-600"
          >
            + Add page
          </button>
        )}
      </div>
    </div>
  )
}

// ── Campaign modal (create / edit) ────────────────────────────────────────────
function CampaignModal({
  initial,
  allCampaigns,
  onSave,
  onClose,
}: {
  initial?: Partial<Campaign>
  allCampaigns: Campaign[]
  onSave: (data: Partial<Campaign>) => Promise<void>
  onClose: () => void
}) {
  const [name, setName]         = useState(initial?.name ?? '')
  const [desc, setDesc]         = useState(initial?.description ?? '')
  const [color, setColor]       = useState(initial?.color ?? '#6366f1')
  const [parent, setParent]     = useState(initial?.parent_campaign_id ?? '')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState('')

  // Goals state
  const g = initial?.goals ?? {}
  const [trafficGoal, setTrafficGoal]   = useState(String(g.traffic_goal ?? ''))
  const [trafficPeriod, setTrafficPeriod] = useState<'monthly' | 'weekly'>(g.traffic_period ?? 'monthly')
  const [rankingGoal, setRankingGoal]   = useState(String(g.ranking_goal ?? ''))
  const [rankingKws, setRankingKws]     = useState((g.ranking_keywords ?? []).join(', '))
  const [briefTarget, setBriefTarget]   = useState(String(g.brief_completion_target ?? ''))
  const [customGoal, setCustomGoal]     = useState(g.custom ?? '')

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError('')
    try {
      const goals: CampaignGoals = {}
      if (trafficGoal)  goals.traffic_goal    = Number(trafficGoal)
      if (trafficGoal)  goals.traffic_period  = trafficPeriod
      if (rankingGoal)  goals.ranking_goal    = Number(rankingGoal)
      if (rankingKws)   goals.ranking_keywords = rankingKws.split(',').map(k => k.trim()).filter(Boolean)
      if (briefTarget)  goals.brief_completion_target = Number(briefTarget)
      if (customGoal)   goals.custom = customGoal.trim()

      await onSave({
        name: name.trim(),
        description: desc.trim() || null,
        color,
        parent_campaign_id: parent || null,
        goals,
      } as Partial<Campaign>)
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose()
  }

  const otherCampaigns = allCampaigns.filter(c => c.id !== initial?.id)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={handleBackdrop}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-800">
          <h2 className="text-white font-semibold text-lg">
            {initial?.id ? 'Edit Campaign' : 'New Campaign'}
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Campaign name *</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Q2 SEO Push"
              autoFocus
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          {/* Color + Description row */}
          <div className="flex gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Color</label>
              <div className="flex gap-2 flex-wrap">
                {COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-offset-gray-900 ring-white scale-110' : ''}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea
              value={desc}
              onChange={e => setDesc(e.target.value)}
              rows={2}
              placeholder="Optional description..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          {/* Parent campaign */}
          {otherCampaigns.length > 0 && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Parent campaign (optional)</label>
              <select
                value={parent}
                onChange={e => setParent(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="">— None —</option>
                {otherCampaigns.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Goals section */}
          <div className="border border-gray-800 rounded-xl p-4 space-y-4">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Goals (optional)</p>

            {/* Traffic */}
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-1">🎯 Traffic goal (clicks)</label>
                <input
                  type="number"
                  value={trafficGoal}
                  onChange={e => setTrafficGoal(e.target.value)}
                  placeholder="e.g. 5000"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Period</label>
                <select
                  value={trafficPeriod}
                  onChange={e => setTrafficPeriod(e.target.value as 'monthly' | 'weekly')}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none"
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                </select>
              </div>
            </div>

            {/* Ranking */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">📍 Avg ranking goal (position ≤)</label>
              <input
                type="number"
                value={rankingGoal}
                onChange={e => setRankingGoal(e.target.value)}
                placeholder="e.g. 5"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">Keywords to track (comma-separated)</label>
              <input
                value={rankingKws}
                onChange={e => setRankingKws(e.target.value)}
                placeholder="e.g. buy game, sell game, g2g"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Brief completion */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">📝 Brief completion target (%)</label>
              <input
                type="number"
                min="0"
                max="100"
                value={briefTarget}
                onChange={e => setBriefTarget(e.target.value)}
                placeholder="e.g. 80"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Custom */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">💬 Custom goal</label>
              <input
                value={customGoal}
                onChange={e => setCustomGoal(e.target.value)}
                placeholder="e.g. Increase revenue from organic by 20%"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-3 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-xl py-2.5 transition text-sm"
            >
              {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Create campaign'}
            </button>
            <button
              onClick={onClose}
              className="px-6 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2.5 transition text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main KanbanBoard ──────────────────────────────────────────────────────────
export default function CampaignKanban({ initial }: { initial: Campaign[] }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>(
    [...initial].sort((a, b) => a.position - b.position)
  )
  const [activeId, setActiveId]     = useState<string | null>(null)
  const [activeType, setActiveType] = useState<'campaign' | 'page' | null>(null)

  const [showModal, setShowModal]   = useState(false)
  const [editingCampaign, setEditingCampaign] = useState<Campaign | undefined>()
  const [deletingId, setDeletingId]       = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )

  // ── Find helpers ────────────────────────────────────────────────────────────
  function findCampaign(id: string) {
    return campaigns.find(c => c.id === id)
  }
  function findPageCampaign(pageId: string) {
    return campaigns.find(c => c.campaign_pages.some(p => p.id === pageId))
  }
  function findPage(pageId: string) {
    for (const c of campaigns) {
      const p = c.campaign_pages.find(p => p.id === pageId)
      if (p) return p
    }
    return null
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────
  function onDragStart({ active }: DragStartEvent) {
    setActiveId(active.id as string)
    setActiveType((active.data.current as { type: 'campaign' | 'page' })?.type ?? null)
  }

  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || active.id === over.id) return
    const aType = (active.data.current as { type: string })?.type
    if (aType !== 'page') return

    const sourceCampaign = findPageCampaign(active.id as string)
    if (!sourceCampaign) return

    // Determine target campaign
    let targetCampaignId: string | null = null
    const overType = (over.data.current as { type: string })?.type
    if (overType === 'campaign') {
      targetCampaignId = over.id as string
    } else if (overType === 'page') {
      targetCampaignId = findPageCampaign(over.id as string)?.id ?? null
    }

    if (!targetCampaignId || targetCampaignId === sourceCampaign.id) return

    // Move page visually
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
    setActiveId(null)
    setActiveType(null)
    if (!over) return

    const aType = (active.data.current as { type: string })?.type

    if (aType === 'campaign') {
      // Reorder columns
      const oldIdx = campaigns.findIndex(c => c.id === active.id)
      const newIdx = campaigns.findIndex(c => c.id === over.id)
      if (oldIdx === newIdx) return
      const reordered = arrayMove(campaigns, oldIdx, newIdx)
      setCampaigns(reordered)
      // Persist
      fetch('/api/campaigns', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: reordered.map(c => c.id) }),
      })
    } else if (aType === 'page') {
      // Page moved — figure out target campaign (already moved visually in onDragOver)
      const overType = (over.data.current as { type: string })?.type
      const targetCampaignId = overType === 'campaign'
        ? over.id as string
        : findPageCampaign(over.id as string)?.id

      const sourceCampaignAfter = findPageCampaign(active.id as string)
      if (!targetCampaignId || !sourceCampaignAfter) return

      // Find the campaign_id where this page now lives (after visual move)
      const liveHostId = sourceCampaignAfter.id

      fetch(`/api/campaigns/${liveHostId}/pages`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: active.id,
          target_campaign_id: liveHostId,
        }),
      })
    }
  }

  // ── API actions ─────────────────────────────────────────────────────────────
  async function createCampaign(data: Partial<Campaign>) {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed to create campaign')
    setCampaigns(prev => [...prev, { ...json.campaign, campaign_pages: [] }])
  }

  async function updateCampaign(data: Partial<Campaign>) {
    const id = editingCampaign!.id
    const res = await fetch(`/api/campaigns/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed to update campaign')
    setCampaigns(prev => prev.map(c => c.id === id ? { ...c, ...data } : c))
  }

  async function confirmDeleteCampaign() {
    if (!deletingId) return
    setDeleteLoading(true)
    const res = await fetch(`/api/campaigns/${deletingId}`, { method: 'DELETE' })
    if (res.ok) {
      setCampaigns(prev => prev.filter(c => c.id !== deletingId))
    }
    setDeletingId(null)
    setDeleteLoading(false)
  }

  const addPageToRef = useRef<((campaignId: string, url: string) => Promise<void>) | null>(null)
  addPageToRef.current = useCallback(async (campaignId: string, url: string) => {
    const res = await fetch(`/api/campaigns/${campaignId}/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_url: url }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? 'Failed to add page')
    setCampaigns(prev => prev.map(c =>
      c.id === campaignId
        ? { ...c, campaign_pages: [...c.campaign_pages, json.page] }
        : c
    ))
  }, [])

  async function removePage(campaignId: string, pageId: string) {
    const res = await fetch(`/api/campaigns/${campaignId}/pages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: pageId }),
    })
    if (res.ok) {
      setCampaigns(prev => prev.map(c =>
        c.id === campaignId
          ? { ...c, campaign_pages: c.campaign_pages.filter(p => p.id !== pageId) }
          : c
      ))
    }
  }

  function openEdit(campaign: Campaign) {
    setEditingCampaign(campaign)
    setShowModal(true)
  }

  function closeModal() {
    setShowModal(false)
    setEditingCampaign(undefined)
  }

  // Active drag items for overlay
  const activeCampaign = activeType === 'campaign' ? findCampaign(activeId!) : null
  const activePage = activeType === 'page' ? findPage(activeId!) : null
  const activePageCampaign = activePage ? findPageCampaign(activeId!) : null

  const campaignIds = campaigns.map(c => c.id)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-8 py-6 border-b border-gray-800 flex-shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-white">Campaigns</h1>
          <p className="text-gray-400 text-sm mt-1">
            Drag pages between campaigns. Drag columns to reorder.
          </p>
        </div>
        <button
          onClick={() => { setEditingCampaign(undefined); setShowModal(true) }}
          className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl px-4 py-2 text-sm transition"
        >
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
              <p className="text-gray-400 text-sm mb-6 max-w-xs">
                Create your first campaign to start grouping pages into focused initiatives.
              </p>
              <button
                onClick={() => setShowModal(true)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl px-6 py-2.5 text-sm transition"
              >
                + New Campaign
              </button>
            </div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={campaignIds} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-5 items-start h-full pb-4">
                {campaigns.map(campaign => (
                  <CampaignColumn
                    key={campaign.id}
                    campaign={campaign}
                    allCampaigns={campaigns}
                    onRemovePage={removePage}
                    onAddPage={(...args) => addPageToRef.current!(...args)}
                    onEdit={openEdit}
                    onDelete={setDeletingId}
                  />
                ))}
                {/* Add campaign shortcut */}
                <button
                  onClick={() => { setEditingCampaign(undefined); setShowModal(true) }}
                  className="flex-shrink-0 w-72 h-24 rounded-xl border-2 border-dashed border-gray-800 hover:border-gray-600 text-gray-600 hover:text-gray-400 flex items-center justify-center gap-2 text-sm transition"
                >
                  + New Campaign
                </button>
              </div>
            </SortableContext>

            <DragOverlay>
              {activeCampaign && (
                <CampaignColumn
                  campaign={activeCampaign}
                  allCampaigns={campaigns}
                  onRemovePage={() => {}}
                  onAddPage={async () => {}}
                  onEdit={() => {}}
                  onDelete={() => {}}
                  isDragOverlay
                />
              )}
              {activePage && activePageCampaign && (
                <PageCard
                  page={activePage}
                  campaignId={activePageCampaign.id}
                  color={activePageCampaign.color}
                  onRemove={() => {}}
                  isDragOverlay
                />
              )}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Delete confirm */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-white font-semibold mb-2">Delete campaign?</h3>
            <p className="text-gray-400 text-sm mb-4">All pages will be removed from this campaign. This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeletingId(null)} className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-xl py-2 text-sm">Cancel</button>
              <button onClick={confirmDeleteCampaign} disabled={deleteLoading} className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl py-2 text-sm">{deleteLoading ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showModal && (
        <CampaignModal
          initial={editingCampaign}
          allCampaigns={campaigns}
          onSave={editingCampaign ? updateCampaign : createCampaign}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
