'use client'

import { useEffect, useMemo, useState, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

// ─── Mimir Memory Admin ────────────────────────────────────────────────────
// Browse what Mimir has learned + manage manually-added rules/preferences.
//
// What lives here:
//   • All memories owned by the active user
//   • Filter by scope / category, full-text search
//   • Pin (force-always-include), archive, edit content / importance
//   • Manual add — for cases Mimir never extracted (or for inviolable rules
//     you want to set up-front, like brand voice rules)

type MemoryScope    = 'global' | 'site' | 'topic' | 'product'
type MemoryCategory = 'preference' | 'fact' | 'rule' | 'lesson'

interface Memory {
  id:                     string
  scope:                  MemoryScope
  site_slug:              string | null
  topic_slug:             string | null
  relation_id:            string | null
  /** Sprint MIMIR.TIER.LEARN — tier scope (1, 2, or null). */
  tier:                   number | null
  /** Sprint MIMIR.TIER.LEARN — FK to product_tiers row. */
  product_tier_id:        string | null
  /** Sprint MIMIR.NOTES.APPLY — denormalized parent product category. */
  product_category:       string | null
  /** Sprint MIMIR.NOTES.APPLY — true = pattern applies cross-product within category. */
  apply_to_category:      boolean
  category:               MemoryCategory
  content:                string
  tags:                   string[]
  importance:             number
  pinned:                 boolean
  expires_at:             string | null
  source_kind:            'manual' | 'extracted' | 'imported'
  source_conversation_id: string | null
  archived:               boolean
  created_at:             string
  updated_at:             string
  /** Sprint MIMIR.POLISH.3 — auto-tuning metadata (optional, hydrated when present). */
  applied_count?:         number
  last_applied_at?:       string | null
}

const SCOPES:     MemoryScope[]    = ['global', 'site', 'topic', 'product']
const CATEGORIES: MemoryCategory[] = ['rule', 'preference', 'lesson', 'fact']
const SOURCES = ['manual', 'extracted', 'imported'] as const
type SourceKind = (typeof SOURCES)[number]
type TierFilter = '' | '1' | '2' | 'untagged'

interface MemoryProductOption {
  id:           string
  product_name: string
  tier:         number | null
  market:       string | null
  category:     string | null
  site_slug:    string
  memory_count: number
}

export default function MimirMemoriesPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500">Loading…</div>}>
      <MimirMemoriesPageInner />
    </Suspense>
  )
}

function MimirMemoriesPageInner() {
  const router = useRouter()
  const sp     = useSearchParams()

  const [memories,    setMemories]   = useState<Memory[]>([])
  const [loading,     setLoading]    = useState(true)
  const [scopeF,      setScopeF]     = useState<MemoryScope | ''>((sp.get('scope') as MemoryScope) || '')
  const [categoryF,   setCategoryF]  = useState<MemoryCategory | ''>((sp.get('category') as MemoryCategory) || '')
  const [sourceF,     setSourceF]    = useState<SourceKind | ''>((sp.get('source') as SourceKind) || '')
  const [tierF,       setTierF]      = useState<TierFilter>((sp.get('tier') as TierFilter) || '')
  const [productF,    setProductF]   = useState<string>(sp.get('product') ?? '')
  const [importMin,   setImportMin]  = useState<number>(parseInt(sp.get('importance_min') ?? '0', 10) || 0)
  const [crossOnly,   setCrossOnly]  = useState<boolean>(sp.get('cross_only') === '1')
  const [search,      setSearch]     = useState(sp.get('q') ?? '')
  const [showArchived, setShowArchived] = useState(sp.get('include_archived') === '1')
  const [refreshTick, setRefreshTick] = useState(0)

  // Sprint MIMIR.POLISH.2 — load product dropdown options once. Refreshes on
  // tick so a newly-attached memory shows up in the dropdown immediately.
  const [productOptions, setProductOptions] = useState<MemoryProductOption[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/mimir/memories/products')
        const data = await res.json()
        if (!cancelled) setProductOptions(data.products ?? [])
      } catch { if (!cancelled) setProductOptions([]) }
    })()
    return () => { cancelled = true }
  }, [refreshTick])

  // Sprint MIMIR.POLISH.2 — sync filter state back to URL (shareable links).
  // Debounce-skip on the search box since it changes on every keystroke; the
  // URL update piggy-backs on the fetch effect below by setting all params
  // at once.
  useEffect(() => {
    const params = new URLSearchParams()
    if (scopeF)         params.set('scope', scopeF)
    if (categoryF)      params.set('category', categoryF)
    if (sourceF)        params.set('source', sourceF)
    if (tierF)          params.set('tier', tierF)
    if (productF)       params.set('product', productF)
    if (importMin > 0)  params.set('importance_min', String(importMin))
    if (crossOnly)      params.set('cross_only', '1')
    if (search.trim())  params.set('q', search.trim())
    if (showArchived)   params.set('include_archived', '1')
    const qs = params.toString()
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [scopeF, categoryF, sourceF, tierF, productF, importMin, crossOnly, search, showArchived, router])

  // Add-form state
  const [addOpen, setAddOpen]   = useState(false)
  const [draft,   setDraft]     = useState<Partial<Memory>>({ category: 'rule', scope: 'global', importance: 70 })
  const [tagsRaw, setTagsRaw]   = useState('')
  const [adding,  setAdding]    = useState(false)
  const [addErr,  setAddErr]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams()
        if (scopeF)         params.set('scope', scopeF)
        if (categoryF)      params.set('category', categoryF)
        if (sourceF)        params.set('source', sourceF)
        if (tierF)          params.set('tier', tierF)
        if (productF)       params.set('product', productF)
        if (importMin > 0)  params.set('importance_min', String(importMin))
        if (crossOnly)      params.set('cross_only', '1')
        if (search.trim())  params.set('q', search.trim())
        if (showArchived)   params.set('include_archived', '1')
        const res = await fetch(`/api/mimir/memories?${params}`)
        const data = await res.json()
        if (!cancelled) setMemories(data.memories ?? [])
      } catch { if (!cancelled) setMemories([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [scopeF, categoryF, sourceF, tierF, productF, importMin, crossOnly, search, showArchived, refreshTick])

  async function patchMemory(id: string, patch: Partial<Memory>) {
    const res = await fetch(`/api/mimir/memories?id=${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  async function deleteMemory(id: string) {
    if (!confirm('Hard-delete this memory? Prefer Archive for recoverable removal.')) return
    const res = await fetch(`/api/mimir/memories?id=${id}`, { method: 'DELETE' })
    if (res.ok) setRefreshTick(t => t + 1)
  }

  // Sprint MIMIR.POLISH.5 — applied-trace drill-down modal state.
  const [appliedFor, setAppliedFor] = useState<Memory | null>(null)

  async function addMemory() {
    if (!draft.content?.trim()) { setAddErr('Content required'); return }
    setAdding(true); setAddErr(null)
    try {
      const res = await fetch('/api/mimir/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          tags: tagsRaw.split(',').map(t => t.trim()).filter(Boolean),
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) setAddErr(data.error ?? 'Failed')
      else {
        setDraft({ category: 'rule', scope: 'global', importance: 70 })
        setTagsRaw('')
        setAddOpen(false)
        setRefreshTick(t => t + 1)
      }
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e))
    }
    setAdding(false)
  }

  const counts = useMemo(() => {
    const c = { rule: 0, preference: 0, lesson: 0, fact: 0, pinned: 0 }
    for (const m of memories) {
      c[m.category]++
      if (m.pinned) c.pinned++
    }
    return c
  }, [memories])

  // Sprint MIMIR.POLISH.1 — scope + tier breakdown chips so coverage gaps are
  // visible at a glance. e.g. "60 product / 7 site / 0 global" tells you
  // immediately that site-wide rules are underweighted.
  const breakdown = useMemo(() => {
    const scope = { global: 0, site: 0, topic: 0, product: 0 }
    const tier  = { t1: 0, t2: 0, untagged: 0 }
    const propagate = { cross: 0, single: 0 }
    for (const m of memories) {
      scope[m.scope]++
      if (m.tier === 1) tier.t1++
      else if (m.tier === 2) tier.t2++
      else tier.untagged++
      if (m.apply_to_category) propagate.cross++
      else propagate.single++
    }
    return { scope, tier, propagate }
  }, [memories])

  return (
    <div className="p-6 md:p-8 max-w-6xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🧠 Mimir Memory</h1>
          <p className="text-sm text-gray-400 mt-1">
            Persistent facts, rules, preferences, and lessons Mimir uses to inform every chat.
            Auto-extracted from conversations and manually curated here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SeedButton onSeeded={() => setRefreshTick(t => t + 1)} />
          <button
            onClick={() => setAddOpen(o => !o)}
            className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium rounded-lg transition"
          >
            {addOpen ? 'Cancel' : '+ Add memory'}
          </button>
        </div>
      </div>

      {/* Category KPIs — Sprint MIMIR.POLISH.1 added Facts card (was missing). */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
        <Kpi label="Total"       value={memories.length}   tone="gray" />
        <Kpi label="Rules"       value={counts.rule}       tone="red" />
        <Kpi label="Preferences" value={counts.preference} tone="blue" />
        <Kpi label="Facts"       value={counts.fact}       tone="slate" />
        <Kpi label="Lessons"     value={counts.lesson}     tone="amber" />
        <Kpi label="Pinned"      value={counts.pinned}     tone="purple" />
      </div>

      {/* Sprint MIMIR.POLISH.1 — Coverage breakdown chips. Surfaces lop-sided
       *  distributions (e.g. all memory is product-scope, none is site-wide). */}
      <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-gray-500 uppercase tracking-wide">Scope:</span>
        <Chip label="Global"  value={breakdown.scope.global}  active={breakdown.scope.global > 0}  />
        <Chip label="Site"    value={breakdown.scope.site}    active={breakdown.scope.site > 0}    />
        <Chip label="Topic"   value={breakdown.scope.topic}   active={breakdown.scope.topic > 0}   />
        <Chip label="Product" value={breakdown.scope.product} active={breakdown.scope.product > 0} />
        <span className="text-gray-700">|</span>
        <span className="text-gray-500 uppercase tracking-wide">Tier:</span>
        <Chip label="T1"       value={breakdown.tier.t1}       active={breakdown.tier.t1 > 0}       tone="purple" />
        <Chip label="T2"       value={breakdown.tier.t2}       active={breakdown.tier.t2 > 0}       tone="blue" />
        <Chip label="Untagged" value={breakdown.tier.untagged} active={breakdown.tier.untagged > 0} tone="gray" />
        <span className="text-gray-700">|</span>
        <span className="text-gray-500 uppercase tracking-wide">Reach:</span>
        <Chip label="Cross-product" value={breakdown.propagate.cross}  active={breakdown.propagate.cross > 0}  tone="emerald" />
        <Chip label="Single-product" value={breakdown.propagate.single} active={breakdown.propagate.single > 0} tone="gray" />
      </div>

      {/* Add form */}
      {addOpen && (
        <div className="rounded-lg border border-purple-700/40 bg-purple-950/10 p-4 space-y-3">
          <h2 className="text-sm font-semibold text-white">New memory</h2>
          <textarea
            rows={2}
            maxLength={280}
            value={draft.content ?? ''}
            onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
            placeholder='e.g. "Always use sentence case in marketing titles, never Title Case."'
            className="w-full bg-gray-950 border border-gray-700 rounded-md p-2 text-sm text-white focus:outline-none focus:border-purple-500"
          />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <select
              value={draft.category ?? 'rule'}
              onChange={e => setDraft(d => ({ ...d, category: e.target.value as MemoryCategory }))}
              className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
            >
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              value={draft.scope ?? 'global'}
              onChange={e => setDraft(d => ({ ...d, scope: e.target.value as MemoryScope }))}
              className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
            >
              {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <input
              type="number"
              min={0} max={100}
              value={draft.importance ?? 70}
              onChange={e => setDraft(d => ({ ...d, importance: parseInt(e.target.value, 10) || 0 }))}
              className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
              placeholder="Importance (0-100)"
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-300">
              <input
                type="checkbox"
                checked={!!draft.pinned}
                onChange={e => setDraft(d => ({ ...d, pinned: e.target.checked }))}
              />
              Pinned (always inject)
            </label>
          </div>
          <input
            type="text"
            value={tagsRaw}
            onChange={e => setTagsRaw(e.target.value)}
            placeholder="Tags (comma-separated, e.g. bragi, tone, on_page)"
            className="w-full bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-sm text-gray-200"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addMemory}
              disabled={adding}
              className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm rounded-md"
            >
              {adding ? 'Saving…' : 'Save memory'}
            </button>
            {addErr && <span className="text-xs text-red-400">{addErr}</span>}
          </div>
        </div>
      )}

      {/* Filter bar — Sprint MIMIR.POLISH.2 — expanded with tier/product/source
       *  filters + importance slider + cross-product toggle + URL param sync. */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2 text-sm">
        {/* Row 1: search + primary filters */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search content…"
            className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-purple-500 flex-1 min-w-[200px]"
          />
          <select value={scopeF} onChange={e => setScopeF(e.target.value as MemoryScope | '')} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All scopes</option>
            {SCOPES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={categoryF} onChange={e => setCategoryF(e.target.value as MemoryCategory | '')} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={sourceF} onChange={e => setSourceF(e.target.value as SourceKind | '')} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All sources</option>
            {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Row 2: tier + product + importance + reach + archived */}
        <div className="flex flex-wrap items-center gap-2">
          <select value={tierF} onChange={e => setTierF(e.target.value as TierFilter)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200">
            <option value="">All tiers</option>
            <option value="1">T1 only</option>
            <option value="2">T2 only</option>
            <option value="untagged">Untagged</option>
          </select>
          <select value={productF} onChange={e => setProductF(e.target.value)} className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200 max-w-xs">
            <option value="">All products ({productOptions.length})</option>
            {productOptions.map(p => (
              <option key={p.id} value={p.id}>
                {p.product_name}{p.tier ? ` · T${p.tier}` : ''}{p.market ? ` · ${p.market}` : ''} ({p.memory_count})
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Importance ≥ <span className="font-semibold text-gray-200 tabular-nums w-8">{importMin}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={importMin}
              onChange={e => setImportMin(parseInt(e.target.value, 10) || 0)}
              className="w-28 accent-purple-500"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={crossOnly} onChange={e => setCrossOnly(e.target.checked)} />
            Cross-product only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          {(scopeF || categoryF || sourceF || tierF || productF || importMin > 0 || crossOnly || search || showArchived) && (
            <button
              onClick={() => {
                setScopeF(''); setCategoryF(''); setSourceF(''); setTierF('')
                setProductF(''); setImportMin(0); setCrossOnly(false)
                setSearch(''); setShowArchived(false)
              }}
              className="ml-auto text-xs text-gray-400 hover:text-purple-300 underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Active filter readout */}
        <div className="text-xs text-gray-500 pt-1 border-t border-gray-800">
          Showing <span className="text-gray-300 font-semibold">{memories.length}</span> memories
          {productF && productOptions.find(p => p.id === productF) && (
            <> · product: <span className="text-purple-300">{productOptions.find(p => p.id === productF)?.product_name}</span></>
          )}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : memories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-800 p-8 text-center text-gray-500">
          No memories yet. Add one above, or chat with Mimir — durable facts auto-extract after each turn.
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map(m => (
            <MemoryCard
              key={m.id}
              m={m}
              onPatch={(patch) => patchMemory(m.id, patch)}
              onDelete={() => deleteMemory(m.id)}
              onShowApplied={() => setAppliedFor(m)}
            />
          ))}
        </div>
      )}

      {/* Sprint MIMIR.POLISH.5 — applied trace modal */}
      {appliedFor && <AppliedTraceModal memory={appliedFor} onClose={() => setAppliedFor(null)} />}
    </div>
  )
}

function MemoryCard({ m, onPatch, onDelete, onShowApplied }: {
  m: Memory
  onPatch: (p: Partial<Memory>) => void
  onDelete: () => void
  onShowApplied: () => void
}) {
  const categoryColors: Record<MemoryCategory, string> = {
    rule:       'border-red-700/40    bg-red-500/5    text-red-300',
    preference: 'border-blue-700/40   bg-blue-500/5   text-blue-300',
    lesson:     'border-amber-700/40  bg-amber-500/5  text-amber-300',
    fact:       'border-gray-700      bg-gray-900     text-gray-300',
  }
  return (
    <div className={`rounded-lg border p-3 ${categoryColors[m.category]} ${m.archived ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-current shrink-0">
          {m.pinned && '📌 '}{m.category}
        </span>
        <p className="flex-1 text-sm text-white">{m.content}</p>
        <span className="text-[10px] text-gray-400 shrink-0">⭐ {m.importance}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-gray-500 flex-wrap">
        <span>scope: <b>{m.scope}</b></span>
        {m.site_slug   && <span>· site: {m.site_slug}</span>}
        {m.topic_slug  && <span>· topic: {m.topic_slug}</span>}
        {m.relation_id && <span>· product</span>}
        {/* Sprint MIMIR.POLISH.2 — tier badge + cross-product reach badge */}
        {m.tier && (
          <span className="px-1.5 py-0.5 rounded-md border border-purple-700/50 bg-purple-500/10 text-purple-300 font-medium">
            T{m.tier}
          </span>
        )}
        {m.product_category && (
          <span className="text-gray-500">· cat: <span className="text-gray-400">{m.product_category}</span></span>
        )}
        {m.apply_to_category && (
          <span
            title="Cross-product: pattern propagates to ALL products in this category"
            className="px-1.5 py-0.5 rounded-md border border-emerald-700/50 bg-emerald-500/10 text-emerald-300 font-medium"
          >
            🌐 cross-product
          </span>
        )}
        {m.tags.length > 0 && <span>· {m.tags.map(t => `#${t}`).join(' ')}</span>}
        <span>· {m.source_kind === 'extracted' ? '🤖 auto' : m.source_kind === 'imported' ? '📥 import' : '✏ manual'}</span>
        {/* Sprint MIMIR.POLISH.5 — applied trace badge; click to open drill-down modal */}
        {typeof m.applied_count === 'number' && m.applied_count > 0 ? (
          <button
            onClick={onShowApplied}
            title={`Click to see briefs that used this memory${m.last_applied_at ? ` · last ${new Date(m.last_applied_at).toLocaleDateString()}` : ''}`}
            className="px-1.5 py-0.5 rounded-md border border-blue-700/50 bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 font-medium cursor-pointer transition-colors"
          >
            📎 {m.applied_count}x
          </button>
        ) : (
          <span
            title="Never applied to a brief yet — candidate for archival if stale"
            className="px-1.5 py-0.5 rounded-md border border-gray-800 text-gray-600 font-medium cursor-help"
          >
            📎 0x
          </span>
        )}
        <span>· {new Date(m.updated_at).toLocaleDateString()}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => onPatch({ pinned: !m.pinned })} className="hover:text-purple-300">
            {m.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button onClick={() => onPatch({ archived: !m.archived })} className="hover:text-amber-300">
            {m.archived ? 'Unarchive' : 'Archive'}
          </button>
          <button onClick={onDelete} className="hover:text-red-300">Delete</button>
        </div>
      </div>
    </div>
  )
}

// ─── Auto-seed button ──────────────────────────────────────────────────────
// Triggers a backend scan of tier products, KB rules, brief outcomes, and
// active campaigns — turning them into Mimir memories so the assistant has
// context from day one without waiting for the user to chat about each one.
function SeedButton({ onSeeded }: { onSeeded: () => void }) {
  const [busy,   setBusy]   = useState(false)
  const [result, setResult] = useState<{ inserted: { tier: number; kb: number; outcomes: number; campaigns: number }; skipped: number; errors: string[] } | null>(null)

  async function run() {
    if (busy) return
    if (!confirm('Scan tier products, knowledge base, and brief outcomes for the active brand and seed Mimir memory with them?\n\nIdempotent — re-runs skip already-known facts. Useful right after onboarding new tier products or KB rules.')) return
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/mimir/memories/seed', { method: 'POST' })
      const data = await res.json()
      setResult(data)
      onSeeded()
    } catch (e) {
      setResult({ inserted: { tier: 0, kb: 0, outcomes: 0, campaigns: 0 }, skipped: 0, errors: [e instanceof Error ? e.message : String(e)] })
    }
    setBusy(false)
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={run}
        disabled={busy}
        title="Scan tier products + KB + brief outcomes → seed Mimir memory automatically. Idempotent."
        className="px-3 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
      >
        {busy ? '⏳ Seeding…' : '🌱 Auto-seed from workspace'}
      </button>
      {result && (
        <span className="text-xs text-gray-300 max-w-xs">
          ✅ Added: T{result.inserted.tier} · KB{result.inserted.kb} · O{result.inserted.outcomes} · C{result.inserted.campaigns}
          {result.skipped > 0 && ` · skip ${result.skipped}`}
          {result.errors.length > 0 && <span className="text-red-300"> · {result.errors.length} err</span>}
        </span>
      )}
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: 'gray' | 'red' | 'blue' | 'amber' | 'purple' | 'slate' }) {
  const colors = {
    gray:   'border-gray-800   bg-gray-900',
    red:    'border-red-800/40 bg-red-500/5',
    blue:   'border-blue-800/40 bg-blue-500/5',
    amber:  'border-amber-800/40 bg-amber-500/5',
    purple: 'border-purple-800/40 bg-purple-500/5',
    slate:  'border-slate-700/50 bg-slate-500/5',
  }[tone]
  return (
    <div className={`rounded-lg border ${colors} p-3`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-xl font-bold text-white mt-0.5">{value}</p>
    </div>
  )
}

// ─── Sprint MIMIR.POLISH.5 — Applied trace drill-down modal ────────────────
// Lists briefs that injected this memory into their prompt. Lets Galih trace
// "where did this Mimir pattern actually get used?" and spot stale memories
// (0x applied = candidate for archive).
interface AppliedBrief {
  id:               string
  primary_keyword:  string | null
  page:             string | null
  status:           string | null
  tyr_score:        number | null
  created_at:       string
  updated_at:       string
}

function AppliedTraceModal({ memory, onClose }: { memory: Memory; onClose: () => void }) {
  const [loading,  setLoading]  = useState(true)
  const [briefs,   setBriefs]   = useState<AppliedBrief[]>([])
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true); setError(null)
      try {
        const res  = await fetch(`/api/mimir/memories/${memory.id}/applied`)
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(data.error ?? 'Failed to load')
        } else {
          setBriefs(data.briefs ?? [])
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [memory.id])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm"
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-gray-900 border border-gray-700 rounded-lg max-w-3xl w-full max-h-[85vh] overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-gray-800">
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-white flex items-center gap-2">
              📎 Applied trace
              <span className="text-xs text-gray-500 font-normal">
                · {memory.applied_count ?? 0} brief{memory.applied_count === 1 ? '' : 's'}
                {memory.last_applied_at && ` · last ${new Date(memory.last_applied_at).toLocaleDateString()}`}
              </span>
            </h2>
            <p className="text-xs text-gray-400 mt-1 line-clamp-2">{memory.content}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none ml-3">×</button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto p-4">
          {loading ? (
            <p className="text-sm text-gray-500 text-center py-8">Loading…</p>
          ) : error ? (
            <p className="text-sm text-red-400 text-center py-8">Error: {error}</p>
          ) : briefs.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <p className="text-sm text-gray-400">No briefs have used this memory yet.</p>
              <p className="text-xs text-gray-500">
                Either Mimir hasn&apos;t picked it as relevant for any recent brief, or it&apos;s a candidate for archival.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {briefs.map(b => (
                <a
                  key={b.id}
                  href={`/content/briefs/${b.id}`}
                  className="block bg-gray-950/40 hover:bg-gray-950/70 border border-gray-800 hover:border-blue-700/50 rounded-lg p-3 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">
                        {b.primary_keyword ?? '(no keyword)'}
                      </p>
                      {b.page && (
                        <p className="text-xs text-gray-500 truncate">{b.page}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right text-xs">
                      {b.tyr_score != null && (
                        <p className={`font-semibold ${b.tyr_score >= 80 ? 'text-emerald-400' : b.tyr_score >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                          Tyr {b.tyr_score}
                        </p>
                      )}
                      <p className="text-gray-500">{b.status ?? '—'}</p>
                      <p className="text-gray-600 text-[10px]">{new Date(b.updated_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Sprint MIMIR.POLISH.1 — small inline chip for breakdown row.
function Chip({
  label, value, active, tone = 'slate',
}: {
  label:   string
  value:   number
  active:  boolean
  tone?:   'slate' | 'purple' | 'blue' | 'gray' | 'emerald'
}) {
  const baseTone = {
    slate:   active ? 'bg-slate-800/60   border-slate-600   text-slate-200'   : 'bg-gray-900/30 border-gray-800 text-gray-600',
    purple:  active ? 'bg-purple-800/30  border-purple-600  text-purple-200'  : 'bg-gray-900/30 border-gray-800 text-gray-600',
    blue:    active ? 'bg-blue-800/30    border-blue-600    text-blue-200'    : 'bg-gray-900/30 border-gray-800 text-gray-600',
    emerald: active ? 'bg-emerald-800/30 border-emerald-600 text-emerald-200' : 'bg-gray-900/30 border-gray-800 text-gray-600',
    gray:    active ? 'bg-gray-800       border-gray-600    text-gray-200'    : 'bg-gray-900/30 border-gray-800 text-gray-600',
  }[tone]
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border ${baseTone}`}>
      <span>{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  )
}
