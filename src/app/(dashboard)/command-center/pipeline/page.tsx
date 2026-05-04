'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import type { JourneyItem, PipelineStageInfo, BriefSummary, Actor } from '@/app/api/pipeline-journey/route'

// ── Actor avatar (consistent with /team-performance pattern) ──────────────────

function actorInitials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]/).filter(Boolean)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

function actorColor(email: string): string {
  const colors = ['bg-indigo-600', 'bg-purple-600', 'bg-pink-600', 'bg-rose-600', 'bg-orange-600', 'bg-teal-600', 'bg-cyan-600', 'bg-blue-600']
  let hash = 0
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[hash]
}

function actorDisplayName(email: string): string {
  // "galih.priambodo@g2g.com" → "Galih"
  const local = email.split('@')[0].split(/[._-]/)[0] ?? email
  return local.charAt(0).toUpperCase() + local.slice(1)
}

function ActorBadge({ actor }: { actor: Actor }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
      <span
        className={`inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-semibold text-white ${actorColor(actor.email)}`}
        title={actor.email}
      >
        {actorInitials(actor.email)}
      </span>
      <span>{actorDisplayName(actor.email)}</span>
    </span>
  )
}

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
  blue:   { dot: 'bg-blue-500',   badge: 'bg-blue-500/15 text-blue-400 border-blue-500/30',       icon: 'bg-blue-500/20 border-blue-500/40 text-blue-400',   text: 'text-blue-400',   border: 'border-blue-500/40' },
  purple: { dot: 'bg-purple-500', badge: 'bg-purple-500/15 text-purple-400 border-purple-500/30', icon: 'bg-purple-500/20 border-purple-500/40 text-purple-400', text: 'text-purple-400', border: 'border-purple-500/40' },
  amber:  { dot: 'bg-amber-500',  badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30',    icon: 'bg-amber-500/20 border-amber-500/40 text-amber-400',   text: 'text-amber-400',  border: 'border-amber-500/40' },
  indigo: { dot: 'bg-indigo-500', badge: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30', icon: 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400', text: 'text-indigo-400', border: 'border-indigo-500/40' },
  green:  { dot: 'bg-emerald-500',badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', icon: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400', text: 'text-emerald-400', border: 'border-emerald-500/40' },
  pink:   { dot: 'bg-pink-500',   badge: 'bg-pink-500/15 text-pink-400 border-pink-500/30',       icon: 'bg-pink-500/20 border-pink-500/40 text-pink-400',    text: 'text-pink-400',   border: 'border-pink-500/40' },
  teal:   { dot: 'bg-teal-500',   badge: 'bg-teal-500/15 text-teal-400 border-teal-500/30',       icon: 'bg-teal-500/20 border-teal-500/40 text-teal-400',    text: 'text-teal-400',   border: 'border-teal-500/40' },
}

// ── Output type config ────────────────────────────────────────────────────────

const OUTPUT_TYPES = [
  { id: 'new_page',          label: 'New Page',      icon: '📄', desc: 'Create a new category/landing page' },
  { id: 'optimize_existing', label: 'Optimization',  icon: '✏️',  desc: 'Improve existing page to recapture rankings' },
  { id: 'outreach',          label: 'Outreach',      icon: '🤝', desc: 'Link-building pitch to external sites' },
  { id: 'blog_post',         label: 'Blog Post',     icon: '✍️',  desc: 'Guest article for gaming editorial publications' },
] as const

type OutputTypeId = typeof OUTPUT_TYPES[number]['id']

function briefStatusLabel(status: string): { label: string; cls: string } {
  if (status === 'generating' || status === 'draft')
    return { label: 'generating…', cls: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10 animate-pulse' }
  if (status === 'agent_generated')
    return { label: 'ready', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' }
  if (status === 'reviewed')
    return { label: 'reviewed', cls: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' }
  if (status === 'published')
    return { label: 'published', cls: 'text-teal-400 border-teal-500/30 bg-teal-500/10' }
  return { label: status, cls: 'text-gray-400 border-gray-700 bg-gray-800' }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StageIcon({ status, stageColor }: { status: PipelineStageInfo['status']; stageColor: StageColor }) {
  const c = COLOR[stageColor]
  if (status === 'done')
    return (
      <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-emerald-500/20 border border-emerald-500/40 text-emerald-400">
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

// ── Triage panel (the interactive piece) ─────────────────────────────────────

type TriagePhase = 'idle' | 'selecting' | 'generating' | 'done'

function TriagePanel({
  oppId,
  triageStatus,
  oppBriefs,
  onApproved,
  onDismissed,
}: {
  oppId:        string
  triageStatus: PipelineStageInfo['status']
  oppBriefs:    BriefSummary[]
  onApproved:   () => void
  onDismissed:  () => void
}) {
  const [phase,         setPhase]         = useState<TriagePhase>('idle')
  const [selectedTypes, setSelectedTypes] = useState<Set<OutputTypeId>>(new Set())
  const [generating,    setGenerating]    = useState(false)
  const [dismissing,    setDismissing]    = useState(false)
  const [error,         setError]         = useState<string | null>(null)

  // If already approved (status from server), show done immediately
  if (triageStatus === 'done') {
    return (
      <p className="text-xs text-gray-500 mt-1">
        Approved — {oppBriefs.length} brief{oppBriefs.length !== 1 ? 's' : ''} queued
      </p>
    )
  }

  function toggleType(id: OutputTypeId) {
    setSelectedTypes(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleDismiss() {
    setDismissing(true)
    setError(null)
    try {
      const res = await fetch('/api/opportunities', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids: [oppId], status: 'dismissed' }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'Dismiss failed')
      }
      onDismissed()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
      setDismissing(false)
    }
  }

  async function handleGenerate() {
    if (!selectedTypes.size) return
    setGenerating(true)
    setError(null)
    try {
      const res = await fetch('/api/pipeline-journey/approve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ oppId, outputTypes: Array.from(selectedTypes) }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? 'Approval failed')
      }
      setPhase('done')
      onApproved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setGenerating(false)
    }
  }

  // Phase: idle → show Approve + Dismiss buttons
  if (phase === 'idle') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => setPhase('selecting')}
          className="text-[11px] px-3 py-1.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-400 hover:bg-amber-500/25 transition font-medium"
        >
          Approve
        </button>
        <button
          onClick={handleDismiss}
          disabled={dismissing}
          className="text-[11px] px-3 py-1.5 rounded bg-gray-800 border border-gray-700 text-gray-500 hover:border-red-500/40 hover:text-red-400 hover:bg-red-500/10 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>
    )
  }

  // Phase: selecting → type picker
  return (
    <div className="mt-2 space-y-2">
      <p className="text-[11px] text-gray-500">Choose brief type(s) to generate:</p>

      <div className="flex flex-wrap gap-1.5">
        {OUTPUT_TYPES.map(ot => {
          const sel = selectedTypes.has(ot.id)
          return (
            <button
              key={ot.id}
              onClick={() => toggleType(ot.id)}
              title={ot.desc}
              className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border transition ${
                sel
                  ? 'bg-indigo-500/20 border-indigo-500/50 text-indigo-300'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
              }`}
            >
              <span>{ot.icon}</span>
              {ot.label}
              {sel && <span className="text-indigo-400 text-[10px]">✓</span>}
            </button>
          )
        })}
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          onClick={handleGenerate}
          disabled={!selectedTypes.size || generating}
          className="text-[11px] px-3 py-1.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 transition disabled:opacity-40 disabled:cursor-not-allowed font-medium"
        >
          {generating
            ? 'Queuing briefs…'
            : `Generate ${selectedTypes.size || ''} brief${selectedTypes.size !== 1 ? 's' : ''}`}
        </button>
        <button
          onClick={() => { setPhase('idle'); setSelectedTypes(new Set()) }}
          disabled={generating}
          className="text-[11px] text-gray-600 hover:text-gray-400 transition disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Brief inline viewer ───────────────────────────────────────────────────────

interface BriefDetail {
  id: string
  primary_keyword: string | null
  status: string | null
  tyr_score: number | null
  tyr_status: string | null
  content_outline: { heading?: string; points?: string[] }[] | null
  content_draft: string | null
  faq_suggestions: { question?: string; suggested_answer?: string }[] | null
  new_keywords: { keyword?: string; volume?: number | null }[] | null
  notes: string | null
}

function BriefInlinePanel({ briefId, onClose }: { briefId: string; onClose: () => void }) {
  const [brief, setBrief] = useState<BriefDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setErr(null)
    fetch(`/api/content/briefs/${briefId}`)
      .then(r => r.json())
      .then(j => { if (j.brief) setBrief(j.brief); else setErr('Failed to load brief') })
      .catch(() => setErr('Network error'))
      .finally(() => setLoading(false))
  }, [briefId])

  const outline = Array.isArray(brief?.content_outline) ? brief!.content_outline : []
  const faqs    = Array.isArray(brief?.faq_suggestions) ? brief!.faq_suggestions : []
  const newKws  = Array.isArray(brief?.new_keywords) ? brief!.new_keywords : []

  return (
    <div className="mt-2 border border-indigo-500/30 rounded-lg bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 bg-gray-900/60">
        <span className="text-xs font-semibold text-indigo-300 truncate">
          {brief?.primary_keyword ? `"${brief.primary_keyword}"` : 'Brief'}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href={`/content/briefs/${briefId}`}
            className="text-[10px] text-blue-400 hover:text-blue-300 transition px-2 py-0.5 rounded border border-blue-500/30 bg-blue-500/10"
          >
            Open full →
          </Link>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-400 text-xs leading-none">✕</button>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2.5 max-h-72 overflow-y-auto space-y-3 text-[11px]">
        {loading && (
          <p className="text-gray-500 animate-pulse py-4 text-center">Loading brief…</p>
        )}
        {err && <p className="text-red-400">{err}</p>}

        {brief && !loading && (
          <>
            {/* Status row */}
            {brief.tyr_score != null && (
              <p className="text-gray-500">
                Tyr score: <span className={`font-semibold ${brief.tyr_score >= 70 ? 'text-emerald-400' : brief.tyr_score >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                  {brief.tyr_score}/100
                </span>
              </p>
            )}

            {/* Content outline */}
            {outline.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Content outline</p>
                <ol className="space-y-1.5">
                  {outline.map((s, i) => (
                    <li key={i}>
                      <p className="text-white font-medium">{s.heading ?? `Section ${i + 1}`}</p>
                      {s.points && s.points.length > 0 && (
                        <ul className="mt-0.5 space-y-0.5 pl-3">
                          {s.points.slice(0, 4).map((pt, j) => (
                            <li key={j} className="text-gray-400 before:content-['·'] before:mr-1 before:text-gray-600">{pt}</li>
                          ))}
                          {s.points.length > 4 && (
                            <li className="text-gray-600">+{s.points.length - 4} more points</li>
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* FAQs preview */}
            {faqs.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">FAQs ({faqs.length})</p>
                <ul className="space-y-1">
                  {faqs.slice(0, 3).map((f, i) => (
                    <li key={i} className="text-gray-400">{f.question}</li>
                  ))}
                  {faqs.length > 3 && <li className="text-gray-600">+{faqs.length - 3} more…</li>}
                </ul>
              </div>
            )}

            {/* Target keywords */}
            {newKws.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">Target keywords</p>
                <div className="flex flex-wrap gap-1">
                  {newKws.slice(0, 8).map((k, i) => (
                    <span key={i} className="px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-300">
                      {k.keyword}{k.volume ? ` (${k.volume.toLocaleString()})` : ''}
                    </span>
                  ))}
                  {newKws.length > 8 && <span className="text-gray-600">+{newKws.length - 8}</span>}
                </div>
              </div>
            )}

            {/* No content yet */}
            {outline.length === 0 && faqs.length === 0 && newKws.length === 0 && (
              <p className="text-gray-600 py-3 text-center">
                {brief.status === 'draft' ? 'Bragi is still generating this brief…' : 'No content yet'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Brief type chips ──────────────────────────────────────────────────────────

function BriefChips({ briefs }: { briefs: BriefSummary[] }) {
  const [openId, setOpenId]         = useState<string | null>(null)
  const [retrying, setRetrying]     = useState<string | null>(null)
  const [retryDone, setRetryDone]   = useState<Set<string>>(new Set())

  if (!briefs.length) return null

  async function handleRetry(briefId: string) {
    setRetrying(briefId)
    try {
      await fetch(`/api/content/briefs/${briefId}/regenerate`, { method: 'POST' })
      setRetryDone(prev => new Set([...prev, briefId]))
    } catch { /* silent */ }
    finally { setRetrying(null) }
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {briefs.map(b => {
          const ot  = OUTPUT_TYPES.find(o => o.id === b.outputType)
          const { label: statusLabel, cls } = briefStatusLabel(b.status)
          const isOpen  = openId === b.briefId
          const isReady = b.status === 'agent_generated' || b.status === 'reviewed' || b.status === 'published'
          const isStuck = (b.status === 'draft' || b.status === 'generating') && !retryDone.has(b.briefId)
          const isDoneRetrying = retryDone.has(b.briefId)
          return (
            <div key={b.briefId} className="flex items-center gap-0.5">
              {/* Main chip — click to expand inline panel */}
              <button
                onClick={() => isReady ? setOpenId(isOpen ? null : b.briefId) : undefined}
                title={isReady ? `Click to preview — ${ot?.label ?? b.briefType}` : `${ot?.label ?? b.briefType} · ${statusLabel}`}
                className={`flex items-center gap-1 text-[11px] px-2.5 py-1 ${isStuck ? 'rounded-l-lg' : 'rounded-l-lg'} border-y border-l transition ${cls} ${isOpen ? 'ring-1 ring-indigo-500/50' : isReady ? 'hover:opacity-90 cursor-pointer' : 'cursor-default opacity-70'}`}
              >
                <span>{ot?.icon ?? '📄'}</span>
                <span>{ot?.label ?? b.briefType}</span>
                <span className="opacity-60">· {isDoneRetrying ? 'queued ✓' : statusLabel}</span>
                {isReady && <span className="opacity-40 text-[9px]">{isOpen ? '▲' : '▼'}</span>}
              </button>
              {/* Retry button for stuck briefs */}
              {isStuck && (
                <button
                  onClick={() => handleRetry(b.briefId)}
                  disabled={retrying === b.briefId}
                  title="Brief generation may have timed out — click to retry"
                  className={`flex items-center justify-center text-[10px] px-1.5 py-1 border-y transition ${cls} ${retrying === b.briefId ? 'opacity-40 cursor-not-allowed' : 'hover:opacity-100 opacity-70 cursor-pointer'}`}
                >
                  {retrying === b.briefId ? '…' : '⟳'}
                </button>
              )}
              {/* Direct open button — always visible, no panel needed */}
              <Link
                href={`/content/briefs/${b.briefId}`}
                title="Open full brief"
                className={`flex items-center justify-center text-[10px] px-1.5 py-1 rounded-r-lg border-y border-r transition hover:opacity-100 opacity-50 ${cls}`}
              >
                ↗
              </Link>
            </div>
          )
        })}
      </div>

      {/* Inline brief viewer */}
      {openId && (
        <BriefInlinePanel briefId={openId} onClose={() => setOpenId(null)} />
      )}
    </div>
  )
}

// ── Stage row ─────────────────────────────────────────────────────────────────

function StageRow({
  stage, info, isLast, oppId, oppBriefs, onApproved, onDismissed,
}: {
  stage:       typeof STAGES[number]
  info:        PipelineStageInfo
  isLast:      boolean
  oppId:       string
  oppBriefs:   BriefSummary[]
  onApproved:  () => void
  onDismissed: () => void
}) {
  const c       = COLOR[stage.color]
  const isLocked  = info.status === 'locked'
  const nameColor = isLocked ? 'text-gray-600' : info.status === 'done' ? 'text-emerald-400' : c.text
  const isTriage  = stage.n === 3
  const isBrief   = stage.n === 4

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
              info.status === 'active'       ? `${c.badge}` :
              'text-gray-600 border-gray-800'
            }`}>
              {info.status === 'done' ? 'done' : info.status === 'needs_action' ? 'need action' : info.status === 'active' ? 'running' : 'pending'}
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
        {info.actor && !isLocked && (
          <div className="mt-1">
            <ActorBadge actor={info.actor} />
          </div>
        )}

        {/* Triage: interactive approve panel */}
        {isTriage && !isLocked && (
          <TriagePanel
            oppId={oppId}
            triageStatus={info.status}
            oppBriefs={oppBriefs}
            onApproved={onApproved}
            onDismissed={onDismissed}
          />
        )}

        {/* Brief: multi-type chips instead of single CTA */}
        {isBrief && !isLocked && oppBriefs.length > 0 && (
          <BriefChips briefs={oppBriefs} />
        )}

        {/* Other stages: standard CTA link */}
        {!isTriage && !isBrief && info.cta && !isLocked && (
          <div className="flex items-center gap-2 mt-2">
            <Link
              href={info.cta.href}
              className="text-[11px] px-2.5 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400 hover:text-white hover:bg-gray-700 transition"
            >
              {info.cta.label} →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Opportunity card ──────────────────────────────────────────────────────────

function OppCard({ item, onRefresh }: { item: JourneyItem; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)

  const activeStage = STAGES[item.pipelineStage - 1] ?? STAGES[0]
  const c = COLOR[activeStage.color]

  const chipLabel =
    item.isComplete  ? 'Complete' :
    item.needsAction ? 'Need Action' :
    activeStage.label

  const chipClass =
    item.isComplete  ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' :
    item.needsAction ? 'bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse' :
    c.badge

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
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
          item.isComplete ? 'bg-emerald-500' : item.needsAction ? 'bg-amber-500' : c.dot
        }`} />
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
          {item.briefs.length > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/25">
              {item.briefs.length} brief{item.briefs.length !== 1 ? 's' : ''}
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
              oppId={item.id}
              oppBriefs={item.briefs}
              onApproved={onRefresh}
              onDismissed={onRefresh}
            />
          ))}
          <div className="flex items-center justify-end gap-3 pt-1 pb-0.5">
            <Link
              href={`/content/topics/${encodeURIComponent(item.topicSlug ?? item.id)}`}
              className="text-[11px] text-purple-400 hover:text-purple-300 transition"
            >
              View topic detail →
            </Link>
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
  const [items,        setItems]        = useState<JourneyItem[]>([])
  const [stats,        setStats]        = useState<Stats>({ total: 0, needsAction: 0, inProgress: 0, completed: 0 })
  const [tab,          setTab]          = useState<TabFilter>('all')
  const [loading,      setLoading]      = useState(true)
  const [search,       setSearch]       = useState('')
  const [processing,   setProcessing]   = useState(false)
  const [processMsg,   setProcessMsg]   = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch(`/api/pipeline-journey?site=g2g&limit=60`)
      if (!res.ok) return
      const json = await res.json()
      const journey: JourneyItem[] = json.journey ?? []
      setItems(journey)
      setStats(json.stats ?? { total: 0, needsAction: 0, inProgress: 0, completed: 0 })

      // Auto-retry: if any items have briefs stuck in draft, call process-briefs silently
      const hasStuck = journey.some(it =>
        it.briefs.some(b => b.status === 'draft' || b.status === 'generating')
      )
      if (hasStuck) {
        fetch('/api/cron/process-briefs').catch(() => {/* silent */})
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  // Manual "process stuck" trigger — loops until all stuck briefs are cleared.
  // process-briefs handles 1 brief per invocation (within Hobby's 60s limit).
  // We don't sleep blindly: each invocation already takes ~25-40s while Bragi
  // runs, so we just kick off the next one immediately and let the next call
  // race the previous one (process-briefs query filter prevents double-processing).
  async function processStuck() {
    setProcessing(true)
    setProcessMsg('Starting…')

    let totalProcessed = 0
    let round = 0
    const MAX_ROUNDS = 25 // safety cap — typically 7-10 briefs at once is plenty

    try {
      while (round < MAX_ROUNDS) {
        round++
        setProcessMsg(`Processing brief ${round}…`)

        const res  = await fetch('/api/cron/process-briefs')
        const json = await res.json()
        totalProcessed += json.processed ?? 0
        const remaining = json.remaining ?? 0

        if (json.processed === 0 && remaining === 0) break

        setProcessMsg(
          totalProcessed > 0
            ? `✓ ${totalProcessed} done · ${remaining} remaining…`
            : `Working on it… ${remaining} remaining`
        )

        // Refresh the UI mid-loop so the user can watch briefs flip status live
        if (totalProcessed > 0 && totalProcessed % 2 === 0) {
          fetchData()
        }

        if (remaining === 0) break

        // Brief pause before next invocation — process-briefs is synchronous
        // (it awaits Bragi+Tyr) so by the time the previous call returns, the
        // brief is already done. 2s is just a small buffer.
        await new Promise(r => setTimeout(r, 2_000))
      }

      if (totalProcessed === 0) {
        setProcessMsg('No stuck briefs — all caught up!')
      } else {
        setProcessMsg(`✓ ${totalProcessed} brief${totalProcessed !== 1 ? 's' : ''} processed. Refreshing…`)
        setTimeout(fetchData, 1_500)
      }
    } catch {
      setProcessMsg('Failed to trigger — check console & retry')
    } finally {
      setProcessing(false)
    }
  }

  useEffect(() => { fetchData() }, [fetchData])

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
          { label: 'Total',        value: stats.total,       color: 'text-white'       },
          { label: 'Needs action', value: stats.needsAction, color: 'text-amber-400'   },
          { label: 'In progress',  value: stats.inProgress,  color: 'text-blue-400'    },
          { label: 'Completed',    value: stats.completed,   color: 'text-emerald-400' },
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
        <button
          onClick={processStuck}
          disabled={processing}
          title="Re-trigger Bragi for any briefs stuck in draft state"
          className="text-xs text-indigo-400 hover:text-indigo-300 border border-indigo-500/30 bg-indigo-500/5 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
        >
          {processing ? '⏳ Processing…' : '⚡ Process stuck'}
        </button>
      </div>
      {processMsg && (
        <p className="text-xs text-gray-400 mb-3 px-1">{processMsg}</p>
      )}

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
            <OppCard key={item.id} item={item} onRefresh={fetchData} />
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
