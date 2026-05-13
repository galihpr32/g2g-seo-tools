'use client'

import { useState } from 'react'

// ─── Review reason prompt — post-save modal ─────────────────────────────────
// When a reviewer edits a brief and saves, this modal pops up asking them
// to tag each changed section with a short reason. Reasons feed into the
// learning aggregator (Sprint LEARN.5).
//
// Designed to be lightweight: presets + skip-able. Reviewer can hit Skip
// to defer the explanation — diff capture still works without it.

const PRESET_REASONS = [
  { label: 'Tone too commercial',     value: 'Tone was too commercial/promotional — softened to player-first voice' },
  { label: 'Factually inaccurate',    value: 'AI claim was factually wrong — corrected with verified information' },
  { label: 'Too long',                value: 'Section was too long for the page slot — trimmed' },
  { label: 'Too short / incomplete',  value: 'Section was too thin — added missing details' },
  { label: 'Missing brand voice',     value: 'Did not match our brand voice — rewrote in our standard style' },
  { label: 'Forbidden claim',         value: 'Contained a forbidden claim (CS time, refund %, etc.) — removed' },
  { label: 'Wrong keyword intent',    value: 'Targeted keyword had wrong intent for this page — adjusted' },
  { label: 'Wrong category template', value: 'Followed wrong category structure — re-aligned to actual product type' },
  { label: 'Other',                   value: '' },
]

export interface ChangedSectionPreview {
  section_label: string   // 'intro', 'meta_title', etc.
  diff_summary:  string   // human-friendly preview ('cut 40%', 'minor edits')
  severity:      'minor' | 'major' | 'critical'
}

interface Props {
  open:           boolean
  briefId:        string
  changes:        ChangedSectionPreview[]
  onClose:        () => void
  onSubmitted?:   () => void
}

export default function ReviewReasonModal({ open, briefId, changes, onClose, onSubmitted }: Props) {
  const [reasons,    setReasons]    = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  if (!open) return null
  if (changes.length === 0) return null

  function setReason(section: string, value: string) {
    setReasons(prev => ({ ...prev, [section]: value }))
  }

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      // Filter empty reasons — Skip-all should just close
      const payload = Object.fromEntries(Object.entries(reasons).filter(([, v]) => v.trim()))
      if (Object.keys(payload).length === 0) {
        onClose()
        return
      }
      const res = await fetch(`/api/content/briefs/${briefId}/review-reasons`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reasons: payload }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? 'Save failed')
      } else {
        onSubmitted?.()
        onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSubmitting(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-white font-semibold text-sm">📝 Quick — why these edits?</h2>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Your answers train the AI to do better next time. Optional — Skip if in a hurry.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {changes.map(c => (
            <div key={c.section_label} className="rounded-md border border-gray-800 bg-gray-950 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-white">{c.section_label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  c.severity === 'critical' ? 'border-red-700 bg-red-500/15 text-red-300' :
                  c.severity === 'major'    ? 'border-amber-700 bg-amber-500/15 text-amber-300' :
                                              'border-gray-700 bg-gray-800/40 text-gray-400'
                }`}>{c.severity}</span>
              </div>
              <p className="text-xs text-gray-500 mb-2">{c.diff_summary}</p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {PRESET_REASONS.map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setReason(c.section_label, p.value)}
                    className={`text-[10px] px-2 py-1 rounded border ${
                      reasons[c.section_label] === p.value
                        ? 'border-blue-500 bg-blue-500/20 text-blue-200'
                        : 'border-gray-700 text-gray-300 hover:border-blue-500'
                    }`}
                  >{p.label}</button>
                ))}
              </div>
              <textarea
                rows={2}
                value={reasons[c.section_label] ?? ''}
                onChange={e => setReason(c.section_label, e.target.value)}
                placeholder="Or type custom reason…"
                className="w-full text-xs bg-gray-950 border border-gray-700 rounded-md p-2 text-gray-200"
              />
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-end gap-2 shrink-0">
          {error && <span className="text-xs text-red-400 mr-auto">{error}</span>}
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white">
            Skip
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-md"
          >
            {submitting ? 'Saving…' : 'Save reasons'}
          </button>
        </div>
      </div>
    </div>
  )
}
