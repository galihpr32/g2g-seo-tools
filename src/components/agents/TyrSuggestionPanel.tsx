'use client'

/**
 * TyrSuggestionPanel — client-side action panel that follows Tyr's auto
 * suggestion. Sits at the top of BriefQualityReview to short-circuit the
 * "what should I do with this score?" decision Specialist 1 makes per brief.
 *
 * Wires action buttons to:
 *   - Override → /api/content/briefs/[id] PATCH status='reviewed' tyr_status='manual_override'
 *   - Full regenerate → /api/content/briefs/[id]/regenerate POST
 *   - Section regenerate → /api/content/briefs/[id]/regenerate-section POST { section }
 *   - Re-run Tyr → /api/content/briefs/[id]/tyr POST  (if exists)
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { TyrSuggestion } from '@/lib/agents/tyr-suggestion'

interface Props {
  briefId:    string
  suggestion: TyrSuggestion
  /** Hide the panel entirely (e.g. brief is already published) */
  hidden?:    boolean
}

const ACTION_THEME: Record<TyrSuggestion['action']['kind'], { color: string; emoji: string; label: string }> = {
  override:           { color: 'border-green-500/40 bg-green-500/5  text-green-300',  emoji: '✓',  label: 'Override → Reviewed' },
  regenerate_full:    { color: 'border-purple-500/40 bg-purple-500/5 text-purple-300', emoji: '🔄', label: 'Full Regenerate'    },
  regenerate_section: { color: 'border-blue-500/40 bg-blue-500/5    text-blue-300',   emoji: '✂️', label: 'Section Regenerate' },
  rerun_tyr:          { color: 'border-amber-500/40 bg-amber-500/5  text-amber-300',  emoji: '⚖️', label: 'Re-run Tyr'         },
  wait:               { color: 'border-gray-700    bg-gray-800/30   text-gray-400',   emoji: '⏸',  label: 'Hold'               },
}

const SECTION_LABEL: Record<'outline' | 'faq' | 'meta' | 'keywords', string> = {
  outline:  'Content Outline',
  faq:      'FAQ Suggestions',
  meta:     'H1 + Meta Description',
  keywords: 'Target Keywords',
}

export default function TyrSuggestionPanel({ briefId, suggestion, hidden }: Props) {
  const router = useRouter()
  const [working, setWorking] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState<string | null>(null)

  if (hidden) return null

  const theme = ACTION_THEME[suggestion.action.kind]

  async function handleAction() {
    setWorking(true); setError(null); setDone(null)
    try {
      const action = suggestion.action
      if (action.kind === 'override') {
        const res = await fetch(`/api/content/briefs/${briefId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ status: 'reviewed', tyr_status_override: 'manual_override' }),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setDone('Marked Reviewed.')
      } else if (action.kind === 'regenerate_full') {
        const res = await fetch(`/api/content/briefs/${briefId}/regenerate`, { method: 'POST' })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setDone('Full regeneration queued — Bragi is rebuilding the brief.')
      } else if (action.kind === 'regenerate_section') {
        const res = await fetch(`/api/content/briefs/${briefId}/regenerate-section`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ section: action.section }),
        })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setDone(`Regenerated ${SECTION_LABEL[action.section]}. Re-run Tyr to verify.`)
      } else if (action.kind === 'rerun_tyr') {
        // Tyr re-run endpoint shape may vary; we hit the /tyr endpoint and
        // surface error if it doesn't exist
        const res = await fetch(`/api/content/briefs/${briefId}/tyr`, { method: 'POST' })
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`)
        setDone('Tyr re-running. Refresh in 30s.')
      }
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className={`rounded-xl border ${theme.color.split(' ').slice(0, 2).join(' ')} p-4 mb-5`}>
      <div className="flex items-start gap-3">
        <div className="text-2xl flex-shrink-0">{theme.emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="text-[10px] uppercase tracking-wider font-semibold text-amber-300">
              🪶 Mimir suggests
            </p>
            <span className="text-[10px] text-gray-500">
              ⚡{suggestion.action.confidence}/3 confidence
            </span>
          </div>
          <h3 className="text-white text-sm font-semibold mb-1">
            {theme.label}
            {suggestion.action.kind === 'regenerate_section' && (
              <span className="text-gray-400 font-normal"> — {SECTION_LABEL[suggestion.action.section]}</span>
            )}
          </h3>
          <p className="text-gray-300 text-xs leading-relaxed mb-3">{suggestion.action.reason}</p>

          {/* Top issues — surface what drove the suggestion */}
          {suggestion.topIssues.length > 0 && (
            <div className="mb-3 space-y-1">
              {suggestion.topIssues.slice(0, 3).map(iss => (
                <div key={iss.dimension} className="text-[11px] text-gray-400 flex items-baseline gap-2">
                  <span className="text-red-400 font-mono w-8 flex-shrink-0">{iss.score}/10</span>
                  <span className="text-gray-300 font-medium">{prettyDim(iss.dimension)}:</span>
                  <span className="text-gray-500 truncate">{iss.comment}</span>
                </div>
              ))}
            </div>
          )}

          {/* Action button + status */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleAction}
              disabled={working}
              className={`text-xs font-semibold px-3 py-1.5 rounded transition border ${theme.color} hover:brightness-125 disabled:opacity-50`}
            >
              {working ? 'Working…' : `${theme.emoji} ${theme.label}`}
            </button>
            <span className="text-[10px] text-gray-600">or use the action bar below for other options</span>
          </div>

          {error && <p className="text-red-400 text-xs mt-2">⚠️ {error}</p>}
          {done  && <p className="text-green-400 text-xs mt-2">✓ {done}</p>}
        </div>
      </div>
    </div>
  )
}

function prettyDim(dim: string): string {
  return dim.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}
