'use client'

import { useState, useEffect } from 'react'

/**
 * Sprint MIMIR.NOTES.INLINE — "Notes for Mimir" textarea on the brief editor.
 *
 * Lets the writer (or SEO lead) jot down freeform context while editing a
 * brief. Each note becomes a mimir_memory tagged with brief_id + tier +
 * product_tier_id so future briefs for the same product (or any T1/T2 brief)
 * benefit from the lesson.
 *
 * The tier badge is the visible signal that Mimir knows what context this
 * brief belongs to — addresses Galih's question "apakah Mimir tau di page ini
 * adalah produk T1?" Yes, and the writer can see it.
 */

interface RecentNote {
  id:         string
  content:    string
  category:   string
  created_at: string
}

const CATEGORY_OPTIONS = [
  { value: 'preference', label: 'Preference' },
  { value: 'fact',       label: 'Fact' },
  { value: 'rule',       label: 'Rule' },
  { value: 'lesson',     label: 'Lesson' },
] as const

export default function BriefMimirNotes({
  briefId,
  tier,
  productTierId,
  productName,
}: {
  briefId:        string
  tier:           1 | 2 | null
  productTierId:  string | null
  productName:    string | null
}) {
  const [content,  setContent]  = useState('')
  const [category, setCategory] = useState<'preference' | 'fact' | 'rule' | 'lesson'>('preference')
  const [busy,     setBusy]     = useState(false)
  const [msg,      setMsg]      = useState<string | null>(null)
  const [recent,   setRecent]   = useState<RecentNote[]>([])

  // Load recent notes for this product if we have a tier link
  useEffect(() => {
    if (!productTierId) return
    let cancelled = false
    fetch(`/api/priority-products/${productTierId}/signal`)
      .then(r => r.ok ? r.json() : { memories: [] })
      .then((d: { memories: RecentNote[] }) => { if (!cancelled) setRecent(d.memories ?? []) })
      .catch(() => { if (!cancelled) setRecent([]) })
    return () => { cancelled = true }
  }, [productTierId])

  async function submit() {
    setMsg(null)
    if (!content.trim()) { setMsg('Note is empty.'); return }
    setBusy(true)
    try {
      const res = await fetch('/api/mimir/memories', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          content:  content.trim(),
          category,
          scope:    tier ? 'product' : 'site',
          brief_id: briefId,
          tier,
          product_tier_id: productTierId,
          tags:     ['brief_note', ...(tier ? [`t${tier}`] : [])],
          importance: tier === 1 ? 80 : tier === 2 ? 70 : 60,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMsg(`Failed: ${data.error ?? 'unknown'}`)
      } else {
        setMsg('Saved to Mimir memory.')
        setContent('')
        // refresh recent list
        if (productTierId) {
          const r = await fetch(`/api/priority-products/${productTierId}/signal`)
          if (r.ok) {
            const d = await r.json() as { memories: RecentNote[] }
            setRecent(d.memories ?? [])
          }
        }
      }
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
      <div className="flex items-baseline gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white uppercase tracking-wider">🧠 Notes for Mimir</h2>
        {tier ? (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            tier === 1
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
          }`}>
            T{tier} {productName ? `· ${productName}` : ''}
          </span>
        ) : (
          <span className="text-[10px] text-gray-500 italic">No tier match — note will be site-scoped</span>
        )}
      </div>
      <p className="text-[11px] text-gray-500 mb-3">
        Anything you want Mimir to remember for future briefs on this {tier ? 'product' : 'site'}.
        E.g. tone notes, CTA preferences, things to avoid, lessons from past edits.
      </p>

      <div className="space-y-2">
        <div className="grid grid-cols-4 gap-1">
          {CATEGORY_OPTIONS.map(c => (
            <button
              key={c.value}
              onClick={() => setCategory(c.value)}
              className={`px-2 py-1 text-[11px] rounded border transition ${
                category === c.value
                  ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                  : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          rows={3}
          maxLength={280}
          placeholder={`e.g. always lead with the launch date when writing for ${productName ?? 'this product'}`}
          className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-sm text-white placeholder-gray-600 resize-none"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-600">{content.length} / 280</span>
          <button
            onClick={submit}
            disabled={busy || !content.trim()}
            className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded"
          >
            {busy ? 'Saving…' : 'Add note for Mimir'}
          </button>
        </div>
        {msg && (
          <p className={`text-[11px] ${msg.startsWith('Failed') ? 'text-red-300' : 'text-emerald-300'}`}>
            {msg}
          </p>
        )}
      </div>

      {productTierId && recent.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-800">
          <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">
            Recent signals for this product · {recent.length}
          </p>
          <ul className="space-y-1.5 max-h-32 overflow-y-auto">
            {recent.slice(0, 4).map(m => (
              <li key={m.id} className="text-[11px] bg-gray-950/50 border border-gray-800 rounded px-2 py-1.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[9px] uppercase tracking-wider text-gray-500">{m.category}</span>
                  <span className="text-[9px] text-gray-600">{new Date(m.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-gray-300 mt-0.5">{m.content}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
