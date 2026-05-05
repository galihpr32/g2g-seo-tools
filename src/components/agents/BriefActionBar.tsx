'use client'

import { useState } from 'react'

interface TyrDimension {
  score:   number
  max:     number
  label?:  string
  note?:   string
}

interface TyrBreakdown {
  strengths?:   string[]
  weaknesses?:  string[]
  suggestions?: string[]
  dimensions?:  Record<string, TyrDimension>
}

interface BriefActionBarProps {
  briefId:         string
  initialStatus:   string
  initialTyrStatus: string | null
  initialTyrScore: number | null
}

/**
 * BriefActionBar
 *
 * Interactive action panel shown on brief detail pages for agent-generated briefs.
 * Provides:
 *  - Run Tyr Review (first-time) / Re-run Tyr (after review)
 *  - Regenerate (with optional user notes — sends tyr feedback as context)
 *  - Override → Reviewed (promote borderline/failed briefs manually)
 *  - Mark Published
 */
export default function BriefActionBar({
  briefId,
  initialStatus,
  initialTyrStatus,
  initialTyrScore,
}: BriefActionBarProps) {
  const [localStatus,    setLocalStatus]    = useState(initialStatus)
  const [localTyrStatus, setLocalTyrStatus] = useState(initialTyrStatus)
  const [localTyrScore,  setLocalTyrScore]  = useState(initialTyrScore)

  // Tyr
  const [runningTyr, setRunningTyr] = useState(false)
  const [tyrError,   setTyrError]   = useState<string | null>(null)
  const [tyrToast,   setTyrToast]   = useState<string | null>(null)

  // Regenerate
  const [regenOpen,    setRegenOpen]    = useState(false)
  const [regenNotes,   setRegenNotes]   = useState('')
  const [regenRunning, setRegenRunning] = useState(false)
  const [regenDone,    setRegenDone]    = useState(false)

  // Status mutations
  const [promoting,  setPromoting]  = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [mutError,   setMutError]   = useState<string | null>(null)

  // ── Tyr ──────────────────────────────────────────────────────────────────

  const runTyr = async () => {
    setRunningTyr(true)
    setTyrError(null)
    try {
      const res  = await fetch(`/api/content/briefs/${briefId}/tyr-review`, { method: 'POST' })
      const data = await res.json() as { ok: boolean; score?: number; tyrStatus?: string; error?: string }
      if (!data.ok) throw new Error(data.error ?? 'Tyr review failed')
      setLocalTyrScore(data.score ?? null)
      setLocalTyrStatus(data.tyrStatus ?? null)
      setTyrToast(`✅ Tyr review done — score: ${data.score}/100 (${data.tyrStatus})`)
      setTimeout(() => setTyrToast(null), 6000)
    } catch (err) {
      setTyrError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setRunningTyr(false)
    }
  }

  // ── Regenerate ───────────────────────────────────────────────────────────

  const submitRegen = async () => {
    setRegenRunning(true)
    setTyrError(null)   // clear any stale error from a previous attempt
    try {
      const res  = await fetch(`/api/content/briefs/${briefId}/regenerate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ notes: regenNotes }),
      })
      const data = await res.json() as { ok?: boolean; error?: string; briefId?: string }
      // Treat HTTP non-2xx as failure even if body shape is unexpected
      if (!res.ok || (data.ok === false)) {
        const reason = data.error ?? `Regeneration failed (HTTP ${res.status})`
        throw new Error(reason)
      }
      setLocalStatus('draft')
      setRegenDone(true)
      setRegenOpen(false)
    } catch (err) {
      setTyrError(err instanceof Error ? err.message : 'Regeneration failed')
    } finally {
      setRegenRunning(false)
    }
  }

  // ── Status mutations ─────────────────────────────────────────────────────

  const patchStatus = async (newStatus: string) => {
    const setter = newStatus === 'published' ? setPublishing : setPromoting
    setter(true)
    setMutError(null)
    try {
      const res  = await fetch(`/api/content/briefs/${briefId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: newStatus }),
      })
      const data = await res.json() as { ok?: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? 'Update failed')
      setLocalStatus(newStatus)
    } catch (err) {
      setMutError(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setter(false)
    }
  }

  // ── Derived state ────────────────────────────────────────────────────────

  const hasBeenReviewed = Boolean(localTyrStatus)
  const isPublished     = localStatus === 'published'
  const isReviewed      = localStatus === 'reviewed' || localStatus === 'published'
  const isBorderline    = localTyrStatus === 'borderline' || localTyrStatus === 'failed'

  const tyrScoreColor =
    localTyrScore == null ? 'text-gray-400' :
    localTyrScore >= 80   ? 'text-green-400' :
    localTyrScore >= 60   ? 'text-amber-400' : 'text-red-400'

  // ── If brief is generating / published, show minimal bar ─────────────────

  if (localStatus === 'generating') {
    return (
      <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 mb-5 text-sm text-orange-300 animate-pulse">
        ⏳ Brief is regenerating… Check back in 15–30 seconds.
      </div>
    )
  }

  if (regenDone) {
    return (
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mb-5 text-sm text-blue-300">
        🔄 Regeneration queued! Bragi is rewriting this brief with Tyr&apos;s feedback. Refresh in ~30 seconds.
      </div>
    )
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5 space-y-4">
      {/* Header row */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">⚙️ Actions</h2>
          {localTyrScore != null && (
            <span className={`text-xs font-mono ${tyrScoreColor}`}>
              Tyr {localTyrScore}/100 · {localTyrStatus}
            </span>
          )}
        </div>

        {/* Status badge */}
        <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
          localStatus === 'published'       ? 'text-green-400 bg-green-500/10 border-green-500/20' :
          localStatus === 'reviewed'        ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' :
          localStatus === 'agent_generated' ? 'text-purple-400 bg-purple-500/10 border-purple-500/20' :
          'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
        }`}>
          {localStatus === 'agent_generated' ? '🤖 AI Draft' : localStatus}
        </span>
      </div>

      {/* Toast messages */}
      {tyrToast && (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 text-sm text-green-300">
          {tyrToast}
        </div>
      )}
      {tyrError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-300">
          ⚠️ {tyrError}
        </div>
      )}
      {mutError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-sm text-red-300">
          ⚠️ {mutError}
        </div>
      )}

      {/* Action buttons */}
      {!isPublished && (
        <div className="flex flex-wrap gap-2">
          {/* Tyr: Run or Re-run */}
          <button
            onClick={runTyr}
            disabled={runningTyr}
            className="px-3 py-1.5 text-sm rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300
                       hover:bg-amber-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {runningTyr ? '⏳ Running…' : hasBeenReviewed ? '🔁 Re-run Tyr' : '⚖️ Run Tyr Review'}
          </button>

          {/* Regenerate */}
          {!regenOpen && (
            <button
              onClick={() => { setTyrError(null); setRegenOpen(true) }}
              className="px-3 py-1.5 text-sm rounded-lg bg-purple-500/10 border border-purple-500/30 text-purple-300
                         hover:bg-purple-500/20 transition"
            >
              🔄 Regenerate
            </button>
          )}

          {/* Override → Reviewed (for borderline / failed results, or any non-reviewed draft) */}
          {!isReviewed && (
            <button
              onClick={() => patchStatus('reviewed')}
              disabled={promoting}
              title="Mark brief as manually reviewed and approved"
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300
                         hover:bg-blue-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {promoting ? '⏳ Saving…' : isBorderline ? '✔ Override → Reviewed' : '✔ Mark Reviewed'}
            </button>
          )}

          {/* Mark Published */}
          <button
            onClick={() => patchStatus('published')}
            disabled={publishing}
            className="px-3 py-1.5 text-sm rounded-lg bg-green-500/10 border border-green-500/30 text-green-300
                       hover:bg-green-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {publishing ? '⏳ Saving…' : '🚀 Mark Published'}
          </button>
        </div>
      )}

      {isPublished && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-green-400">✅ This brief has been published. Tracking ranking impact via Vor.</p>
          <button
            onClick={() => patchStatus('reviewed')}
            disabled={promoting}
            title="Move back to reviewed — clears published_at, keeps Tyr score & content."
            className="px-2.5 py-1 text-xs rounded-lg bg-yellow-500/10 border border-yellow-500/30 text-yellow-300
                       hover:bg-yellow-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {promoting ? '⏳ Saving…' : '↩ Mark Unpublished'}
          </button>
        </div>
      )}

      {/* Regenerate panel */}
      {regenOpen && (
        <div className="border border-purple-500/20 bg-purple-500/5 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-purple-300">🔄 Regenerate Brief</h3>
            <button
              onClick={() => { setRegenOpen(false); setRegenNotes('') }}
              className="text-gray-500 hover:text-gray-300 text-xs transition"
            >
              ✕ Cancel
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Bragi will rewrite this brief using{' '}
            {localTyrStatus ? `Tyr's feedback (score ${localTyrScore}/100) ` : ''}
            as context. Add your own notes below (optional).
          </p>
          <textarea
            value={regenNotes}
            onChange={e => setRegenNotes(e.target.value)}
            placeholder="e.g. Focus more on mobile games. Add a comparison table. Emphasise G2G marketplace trust signals…"
            rows={4}
            maxLength={1000}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200
                       placeholder-gray-600 resize-none focus:outline-none focus:border-purple-500/50"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-600">{regenNotes.length}/1000</span>
            <button
              onClick={submitRegen}
              disabled={regenRunning}
              className="px-4 py-1.5 text-sm rounded-lg bg-purple-600 text-white
                         hover:bg-purple-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {regenRunning ? '⏳ Queuing…' : '🚀 Regenerate now'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
