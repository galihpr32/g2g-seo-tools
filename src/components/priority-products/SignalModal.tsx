'use client'

import { useEffect, useState } from 'react'

/**
 * Sprint T1.MANUAL.INPUT.2 — Combo modal for adding manual signals to a
 * priority product. Three modes:
 *   - note:         freeform observation → mimir_memory only
 *   - opportunity:  becomes a pipeline opp + mimir_memory
 *   - direct_brief: creates brief draft + mimir_memory (skip the opp step)
 *
 * Used from ProductCard on /priority-products and from the detail page.
 */

interface Memory {
  id:          string
  content:     string
  category:    string
  tags:        string[] | null
  importance:  number
  created_at:  string
  source_kind: string
}

type Kind = 'note' | 'opportunity' | 'direct_brief'

export interface SignalModalProduct {
  id:          string
  tier:        1 | 2
  productName: string
  market?:     'us' | 'id' | null
  category?:   string | null
  url?:        string | null
}

const KIND_META: Record<Kind, { label: string; icon: string; help: string }> = {
  note: {
    label: 'Add note',
    icon:  '📝',
    help:  'Just teach Mimir something. No pipeline action. Use for ongoing context like "always emphasize launch date for BNS NEO" or "ID players prefer Dana over GoPay".',
  },
  opportunity: {
    label: 'Add opportunity',
    icon:  '💡',
    help:  'Surface a one-time signal that needs action — newsjack, competitor move, content gap. Creates an opportunity in the pipeline + mirrors to Mimir memory.',
  },
  direct_brief: {
    label: 'Create brief now',
    icon:  '✍️',
    help:  'Skip the opp step — produce a brief draft Bragi can pick up. Use when you already know what content needs to ship.',
  },
}

const CATEGORY_OPTIONS = [
  { value: 'preference', label: 'Preference', help: 'How you want things done' },
  { value: 'fact',       label: 'Fact',       help: 'Verifiable info about brand/team/product' },
  { value: 'rule',       label: 'Rule',       help: 'Hard constraint Mimir must respect' },
  { value: 'lesson',     label: 'Lesson',     help: 'Mistake-from-history not to repeat' },
] as const

export default function SignalModal({
  product,
  isOpen,
  onClose,
  onCreated,
}: {
  product:    SignalModalProduct
  isOpen:     boolean
  onClose:    () => void
  onCreated?: (result: { kind: Kind; memory_id?: string | null; opportunity_id?: string | null; brief_id?: string | null }) => void
}) {
  const [kind,        setKind]         = useState<Kind>('note')
  const [content,     setContent]      = useState('')
  const [category,    setCategory]     = useState<'preference' | 'fact' | 'rule' | 'lesson'>('preference')
  const [topic,       setTopic]        = useState('')
  const [targetUrl,   setTargetUrl]    = useState('')
  const [primaryKw,   setPrimaryKw]    = useState('')
  const [busy,        setBusy]         = useState(false)
  const [msg,         setMsg]          = useState<string | null>(null)
  const [memories,    setMemories]     = useState<Memory[]>([])
  const [memLoading,  setMemLoading]   = useState(false)

  // Reset state when modal opens for a different product
  useEffect(() => {
    if (!isOpen) return
    setKind('note')
    setContent('')
    setCategory('preference')
    setTopic('')
    setTargetUrl(product.url ?? '')
    setPrimaryKw(product.productName)
    setMsg(null)
  }, [isOpen, product.id, product.url, product.productName])

  // Load recent signals when modal opens
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setMemLoading(true)
    fetch(`/api/priority-products/${product.id}/signal`)
      .then(r => r.ok ? r.json() : { memories: [] })
      .then((d: { memories: Memory[] }) => { if (!cancelled) setMemories(d.memories ?? []) })
      .catch(() => { if (!cancelled) setMemories([]) })
      .finally(() => { if (!cancelled) setMemLoading(false) })
    return () => { cancelled = true }
  }, [isOpen, product.id])

  async function submit() {
    setMsg(null)
    if (!content.trim()) { setMsg('Content is required.'); return }
    setBusy(true)
    try {
      const res = await fetch(`/api/priority-products/${product.id}/signal`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          kind,
          content,
          category: kind === 'note' ? category : undefined,
          topic:       kind === 'opportunity'  ? (topic || product.productName) : undefined,
          target_url:  (kind === 'opportunity' || kind === 'direct_brief') ? (targetUrl || product.url || undefined) : undefined,
          primary_keyword: kind === 'direct_brief' ? (primaryKw || product.productName) : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMsg(`Failed: ${data.error ?? 'unknown'}`)
      } else {
        setMsg(buildSuccessMsg(kind, data.created))
        setContent('')
        // refresh recent signals so the new one shows up
        fetch(`/api/priority-products/${product.id}/signal`)
          .then(r => r.ok ? r.json() : { memories: [] })
          .then((d: { memories: Memory[] }) => setMemories(d.memories ?? []))
        onCreated?.({ kind, ...data.created })
      }
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!isOpen) return null

  const tierAccent = product.tier === 1 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-blue-500/40 bg-blue-500/10 text-blue-200'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="bg-gray-950 border border-gray-800 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-800">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${tierAccent}`}>
                T{product.tier}
              </span>
              {product.market && (
                <span className="text-[10px] text-gray-500">{product.market === 'id' ? '🇮🇩 Indonesia' : '🌐 Global/US'}</span>
              )}
              {product.category && (
                <span className="text-[10px] text-gray-500">· {product.category}</span>
              )}
            </div>
            <h2 className="text-base font-semibold text-white">{product.productName}</h2>
            <p className="text-[11px] text-gray-500">Add a signal for Mimir / Bragi to use</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Mode tabs */}
        <div className="flex gap-1 px-5 pt-4">
          {(Object.entries(KIND_META) as Array<[Kind, typeof KIND_META[Kind]]>).map(([k, meta]) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`flex-1 px-3 py-2 text-xs font-medium rounded-t-lg border-b-2 transition ${
                kind === k
                  ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                  : 'border-transparent text-gray-400 hover:text-gray-200'
              }`}
            >
              <span className="mr-1">{meta.icon}</span>
              {meta.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-[11px] text-gray-500">{KIND_META[kind].help}</p>

          {kind === 'note' && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">Category</label>
              <div className="grid grid-cols-4 gap-1">
                {CATEGORY_OPTIONS.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setCategory(c.value)}
                    title={c.help}
                    className={`px-2 py-1.5 text-xs rounded border transition ${
                      category === c.value
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                        : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind === 'opportunity' && (
            <div className="space-y-2">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Opportunity topic
                </label>
                <input
                  type="text"
                  value={topic}
                  onChange={e => setTopic(e.target.value)}
                  placeholder={product.productName}
                  className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-sm text-white placeholder-gray-600"
                />
                <p className="text-[10px] text-gray-600 mt-0.5">Leave blank to use product name as topic.</p>
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Target URL (optional)
                </label>
                <input
                  type="text"
                  value={targetUrl}
                  onChange={e => setTargetUrl(e.target.value)}
                  placeholder={product.url ?? 'e.g. /categories/bns-neo-divine-gems'}
                  className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-xs text-white placeholder-gray-600"
                />
              </div>
            </div>
          )}

          {kind === 'direct_brief' && (
            <div className="space-y-2">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Primary keyword
                </label>
                <input
                  type="text"
                  value={primaryKw}
                  onChange={e => setPrimaryKw(e.target.value)}
                  placeholder={product.productName}
                  className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-sm text-white placeholder-gray-600"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
                  Target URL
                </label>
                <input
                  type="text"
                  value={targetUrl}
                  onChange={e => setTargetUrl(e.target.value)}
                  placeholder={product.url ?? 'Page being optimized'}
                  className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-xs text-white placeholder-gray-600"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1">
              {kind === 'note' ? 'What should Mimir remember?' : kind === 'opportunity' ? 'What did you spot?' : 'Brief context for Bragi'}
            </label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              rows={4}
              maxLength={1000}
              placeholder={
                kind === 'note'
                  ? 'e.g. for BNS NEO, always emphasize launch-date urgency in CTAs'
                  : kind === 'opportunity'
                    ? 'e.g. Genshin 4.5 update drops next Tuesday — newsjack window opens for Mora top-up content'
                    : 'e.g. competitor page outranks us; we need to expand FAQ + add comparison table'
              }
              className="w-full bg-gray-900 border border-gray-800 rounded px-3 py-2 text-sm text-white placeholder-gray-600 resize-none"
            />
            <div className="text-[10px] text-gray-600 mt-0.5 text-right">{content.length} / 1000</div>
          </div>

          {msg && (
            <div className={`text-xs px-3 py-2 rounded border ${
              msg.startsWith('Failed')
                ? 'bg-red-500/10 border-red-500/30 text-red-300'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
            }`}>
              {msg}
            </div>
          )}

          {/* Recent signals */}
          <div className="pt-2 border-t border-gray-800">
            <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">
              Recent signals on this product · {memories.length}
            </p>
            {memLoading ? (
              <p className="text-[11px] text-gray-600">Loading…</p>
            ) : memories.length === 0 ? (
              <p className="text-[11px] text-gray-600 italic">No signals yet. Add the first one above.</p>
            ) : (
              <ul className="space-y-1.5 max-h-40 overflow-y-auto">
                {memories.slice(0, 5).map(m => (
                  <li key={m.id} className="text-[11px] bg-gray-900/50 border border-gray-800 rounded px-2 py-1.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[9px] uppercase tracking-wider text-gray-500">{m.category}</span>
                      <span className="text-[9px] text-gray-600">{new Date(m.created_at).toLocaleDateString()}</span>
                    </div>
                    <p className="text-gray-300 mt-0.5">{m.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-800 bg-gray-900/30">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-white rounded"
            disabled={busy}
          >
            Close
          </button>
          <button
            onClick={submit}
            disabled={busy || !content.trim()}
            className="px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded"
          >
            {busy ? 'Saving…' : KIND_META[kind].label}
          </button>
        </div>
      </div>
    </div>
  )
}

function buildSuccessMsg(kind: Kind, created: { memory_id?: string | null; opportunity_id?: string | null; brief_id?: string | null }): string {
  if (kind === 'note')        return `Saved to Mimir memory.`
  if (kind === 'opportunity') return `Opportunity created. Also saved to Mimir memory.${created.opportunity_id ? '' : ''}`
  if (kind === 'direct_brief') return `Brief draft created. Also saved to Mimir memory.${created.brief_id ? '' : ''}`
  return 'Saved.'
}
