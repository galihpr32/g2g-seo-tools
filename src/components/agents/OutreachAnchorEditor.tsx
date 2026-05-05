'use client'

import { useState } from 'react'

interface OutreachAnchorEditorProps {
  briefId:        string
  initialAnchors: string[]
}

/**
 * OutreachAnchorEditor
 *
 * Inline tag-style editor for the anchor text list on outreach briefs.
 * Reads/writes via PATCH /api/content/briefs/[id] using the `new_keywords`
 * field (which we re-purpose to store anchor variations on outreach briefs).
 *
 * Writers can:
 *   - Click ✕ on an existing chip to delete
 *   - Type a new anchor + Enter (or click + Add) to append
 *   - Reorder by drag is intentionally NOT supported — anchor selection per
 *     outreach campaign is decided by Hermod from this list, order doesn't
 *     matter.
 */
export default function OutreachAnchorEditor({ briefId, initialAnchors }: OutreachAnchorEditorProps) {
  const [anchors, setAnchors] = useState<string[]>(initialAnchors)
  const [draft,   setDraft]   = useState('')
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  const persist = async (newList: string[]) => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/content/briefs/${briefId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          new_keywords: newList.map(k => ({ keyword: k, volume: null })),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const addAnchor = () => {
    const trimmed = draft.trim()
    if (!trimmed) return
    if (anchors.some(a => a.toLowerCase() === trimmed.toLowerCase())) {
      setError(`"${trimmed}" already in the list`)
      return
    }
    if (anchors.length >= 20) {
      setError('Anchor list capped at 20 entries')
      return
    }
    const next = [...anchors, trimmed]
    setAnchors(next)
    setDraft('')
    setError(null)
    void persist(next)
  }

  const removeAnchor = (idx: number) => {
    const next = anchors.filter((_, i) => i !== idx)
    setAnchors(next)
    void persist(next)
  }

  return (
    <div className="space-y-3">
      {/* Existing anchors as removable chips */}
      <div className="flex flex-wrap gap-2">
        {anchors.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No anchor text variations yet — add some below.</p>
        ) : (
          anchors.map((a, i) => (
            <span
              key={`${a}-${i}`}
              className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 px-2.5 py-1 rounded text-xs text-gray-200"
            >
              {a}
              <button
                type="button"
                onClick={() => removeAnchor(i)}
                disabled={saving}
                className="text-gray-500 hover:text-red-400 transition disabled:opacity-50"
                title="Remove"
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {/* Add new anchor */}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={e => { setDraft(e.target.value); setError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAnchor() } }}
          placeholder="e.g. verified marketplace, G2G, trusted account seller…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-purple-500"
        />
        <button
          type="button"
          onClick={addAnchor}
          disabled={!draft.trim() || saving}
          className="px-3 py-1.5 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? '…' : '+ Add'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400">⚠️ {error}</p>
      )}
      <p className="text-[10px] text-gray-500 italic">
        Mix branded ({'"'}G2G{'"'}), generic ({'"'}verified marketplace{'"'}), and topical ({'"'}{'<'}game{'>'} accounts{'"'}) anchors. Avoid exact-match keyword stuffing — Hermod will rotate these per prospect.
      </p>
    </div>
  )
}
