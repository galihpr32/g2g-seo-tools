'use client'

/**
 * PromoteToKbButton — universal "feed this insight back to the knowledge base"
 * action. Used everywhere a user might spot a pattern worth codifying:
 *   - Brief detail page (writer/specialist saw a useful technique)
 *   - Experiment Stop form (Head locking in a validated pattern)
 *   - Future surfaces (rankings page, action items, etc.)
 *
 * Behaviour:
 *   1. Click opens a small modal with title + rule_text + pattern_kind dropdown
 *   2. Pre-fills from `defaultTitle` / `defaultRuleText` / `defaultPatternKind`
 *      so the user has a starting point and can edit before submit.
 *   3. POSTs to /api/knowledge-base/proposals with status='pending'.
 *   4. The Head reviews + approves at /knowledge-base/proposals.
 *
 * The button itself is a small pill — fits inline next to other action buttons
 * without dominating the layout.
 */

import { useState } from 'react'

const PATTERN_KIND_OPTIONS = [
  { value: 'winning',     label: '🏆 Winning pattern' },
  { value: 'cautionary',  label: '⚠️ Cautionary pattern' },
  { value: 'tone',        label: '🎙️ Tone' },
  { value: 'format',      label: '📋 Format / structure' },
  { value: 'exclusion',   label: '🚫 Exclusion / avoid' },
  { value: 'generic',     label: '🧩 Generic' },
] as const

type PatternKind = typeof PATTERN_KIND_OPTIONS[number]['value']

export interface PromoteToKbButtonProps {
  /** Where this insight came from — drives the proposal `source` field. */
  source: 'brief_promote' | 'experiment_promote' | 'manual'
  /** Optional brief id when source='brief_promote' */
  briefId?: string
  /** Optional experiment id when source='experiment_promote' */
  experimentId?: string
  /** Pre-fill values */
  defaultTitle?:       string
  defaultRuleText?:    string
  defaultPatternKind?: PatternKind
  /** Visual variant — 'inline' (small pill) or 'block' (full-width button) */
  variant?: 'inline' | 'block'
  /** Visible label override (defaults to "💡 Promote to KB") */
  label?: string
  /** Optional className override for outer button */
  className?: string
  /** Callback after successful submit (closes modal + can refresh parent) */
  onSubmitted?: () => void
}

export default function PromoteToKbButton(props: PromoteToKbButtonProps) {
  const [open, setOpen] = useState(false)

  const baseBtnClass = props.variant === 'block'
    ? 'w-full bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 text-sm font-semibold px-4 py-2 rounded-lg transition'
    : 'text-xs bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 font-medium px-2.5 py-1.5 rounded transition'

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={props.className ?? baseBtnClass}
        title="Send this insight to the KB review queue"
      >
        {props.label ?? '💡 Promote to KB'}
      </button>

      {open && (
        <PromoteToKbModal
          {...props}
          onClose={() => setOpen(false)}
          onSubmitted={() => {
            setOpen(false)
            props.onSubmitted?.()
          }}
        />
      )}
    </>
  )
}

// ── Modal ──────────────────────────────────────────────────────────────────

interface ModalProps extends PromoteToKbButtonProps {
  onClose:     () => void
  onSubmitted: () => void
}

function PromoteToKbModal(props: ModalProps) {
  const [title,    setTitle]    = useState(props.defaultTitle    ?? '')
  const [ruleText, setRuleText] = useState(props.defaultRuleText ?? '')
  const [kind,     setKind]     = useState<PatternKind>(props.defaultPatternKind ?? 'winning')
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [done,     setDone]     = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !ruleText.trim()) {
      setError('Title and rule text are required.')
      return
    }
    setBusy(true); setError(null)
    try {
      const body: Record<string, unknown> = {
        title:        title.trim(),
        rule_text:    ruleText.trim(),
        pattern_kind: kind,
        source:       props.source,
      }
      if (props.briefId)      body.source_brief_ids     = [props.briefId]
      if (props.experimentId) body.source_experiment_id = props.experimentId

      const res = await fetch('/api/knowledge-base/proposals', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setDone(true)
      setTimeout(() => props.onSubmitted(), 1200)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold text-sm flex items-center gap-2">
            <span>💡</span> Promote insight to Knowledge Base
          </h2>
          <button onClick={props.onClose} aria-label="Close" className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {done ? (
          <div className="p-8 text-center">
            <p className="text-3xl mb-3">✅</p>
            <p className="text-white font-medium">Proposal submitted</p>
            <p className="text-gray-500 text-xs mt-1">Review &amp; apply at /knowledge-base/proposals.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 text-sm">
            <p className="text-xs text-gray-500">
              This proposal goes to the review queue at <span className="text-amber-300">/knowledge-base/proposals</span>. After approval, you (or the Head) pick which KB item field to extend.
            </p>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Title <span className="text-red-500">*</span></label>
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="Short imperative title"
                maxLength={200}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-amber-500"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Rule text <span className="text-red-500">*</span></label>
              <textarea
                value={ruleText}
                onChange={e => setRuleText(e.target.value)}
                placeholder="The actual rule. Be specific. e.g. 'Q4 gold pages should include a price-history visualization in the first 600 words.'"
                rows={4}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-amber-500 resize-none"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Pattern kind</label>
              <select
                value={kind}
                onChange={e => setKind(e.target.value as PatternKind)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-white focus:outline-none focus:border-amber-500"
              >
                {PATTERN_KIND_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {error && <p className="text-red-400 text-xs">⚠️ {error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={props.onClose} className="text-xs text-gray-500 hover:text-gray-300 px-3 py-2 transition">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="text-xs bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-semibold px-4 py-2 rounded-lg transition"
              >
                {busy ? 'Submitting…' : 'Submit proposal'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
