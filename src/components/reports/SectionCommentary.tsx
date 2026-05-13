'use client'

/**
 * SectionCommentary — drop next to any section in /reports/monthly viewer.
 *
 * Pulls comments for (month, section_key) and lets the user add/delete.
 * Inline with the section so the comment travels visually with what it
 * comments on. PPTX export reads from the same table to render the same
 * commentary under each slide.
 */

import { useEffect, useState, useCallback } from 'react'

interface Comment {
  id:              string
  section_key:     string
  body:            string
  author_user_id:  string
  author_name:     string | null
  created_at:      string
  updated_at:      string
}

interface Props {
  /** YYYY-MM */
  month:       string
  sectionKey:  string
  /** Optional friendly label for empty-state messaging */
  sectionLabel?: string
}

export default function SectionCommentary({ month, sectionKey, sectionLabel }: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading]   = useState(true)
  const [draft, setDraft]       = useState('')
  const [posting, setPosting]   = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/reports/monthly/comments?month=${encodeURIComponent(month)}`)
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      const grouped = (d.comments ?? {}) as Record<string, Comment[]>
      setComments(grouped[sectionKey] ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [month, sectionKey])

  useEffect(() => { void load() }, [load])

  async function post() {
    if (!draft.trim()) return
    setPosting(true); setError(null)
    try {
      const r = await fetch('/api/reports/monthly/comments', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ month, section_key: sectionKey, body: draft.trim() }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`)
      setDraft('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setPosting(false)
    }
  }

  async function remove(id: string) {
    if (!confirm('Delete this comment?')) return
    try {
      const r = await fetch(`/api/reports/monthly/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error ?? `HTTP ${r.status}`)
      }
      await load()
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mt-3 border-l-2 border-amber-500/30 pl-3 text-sm">
      <p className="text-[10px] uppercase tracking-wider text-amber-400/70 mb-2">
        💬 Commentary{sectionLabel ? ` — ${sectionLabel}` : ''}
      </p>

      {loading ? (
        <p className="text-gray-600 text-xs italic">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-gray-600 text-xs italic">No commentary yet.</p>
      ) : (
        <div className="space-y-2 mb-3">
          {comments.map(c => (
            <div key={c.id} className="bg-gray-900/60 border border-gray-800 rounded-lg p-2.5">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-500">
                  {c.author_name ?? 'Unknown'} · {new Date(c.created_at).toLocaleDateString()}
                </span>
                <button
                  onClick={() => remove(c.id)}
                  className="text-[10px] text-gray-600 hover:text-red-400"
                >
                  delete
                </button>
              </div>
              <p className="text-gray-200 whitespace-pre-wrap text-xs">{c.body}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={2}
          placeholder="Add commentary…"
          className="flex-1 bg-gray-900 border border-gray-800 rounded-lg px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-500"
        />
        <button
          onClick={post}
          disabled={posting || !draft.trim()}
          className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 disabled:bg-gray-800 disabled:text-gray-600 text-amber-300 text-xs border border-amber-500/30"
        >
          {posting ? '…' : 'Post'}
        </button>
      </div>
      {error && <p className="text-red-400 text-[10px] mt-1">{error}</p>}
    </div>
  )
}
