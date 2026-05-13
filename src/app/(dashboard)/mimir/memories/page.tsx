'use client'

import { useEffect, useMemo, useState } from 'react'

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
}

const SCOPES:     MemoryScope[]    = ['global', 'site', 'topic', 'product']
const CATEGORIES: MemoryCategory[] = ['rule', 'preference', 'lesson', 'fact']

export default function MimirMemoriesPage() {
  const [memories,    setMemories]   = useState<Memory[]>([])
  const [loading,     setLoading]    = useState(true)
  const [scopeF,      setScopeF]     = useState<MemoryScope | ''>('')
  const [categoryF,   setCategoryF]  = useState<MemoryCategory | ''>('')
  const [search,      setSearch]     = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

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
        if (scopeF)        params.set('scope', scopeF)
        if (categoryF)     params.set('category', categoryF)
        if (search.trim()) params.set('q', search.trim())
        if (showArchived)  params.set('include_archived', '1')
        const res = await fetch(`/api/mimir/memories?${params}`)
        const data = await res.json()
        if (!cancelled) setMemories(data.memories ?? [])
      } catch { if (!cancelled) setMemories([]) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [scopeF, categoryF, search, showArchived, refreshTick])

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
        <button
          onClick={() => setAddOpen(o => !o)}
          className="px-3 py-2 bg-purple-700 hover:bg-purple-600 text-white text-sm font-medium rounded-lg transition"
        >
          {addOpen ? 'Cancel' : '+ Add memory'}
        </button>
      </div>

      {/* Category KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <Kpi label="Total"       value={memories.length} tone="gray" />
        <Kpi label="Rules"       value={counts.rule} tone="red" />
        <Kpi label="Preferences" value={counts.preference} tone="blue" />
        <Kpi label="Lessons"     value={counts.lesson} tone="amber" />
        <Kpi label="Pinned"      value={counts.pinned} tone="purple" />
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

      {/* Filter bar */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 flex flex-wrap items-center gap-2 text-sm">
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
        <label className="flex items-center gap-1.5 text-xs text-gray-400">
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
          Show archived
        </label>
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
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MemoryCard({ m, onPatch, onDelete }: { m: Memory; onPatch: (p: Partial<Memory>) => void; onDelete: () => void }) {
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
        {m.tags.length > 0 && <span>· {m.tags.map(t => `#${t}`).join(' ')}</span>}
        <span>· {m.source_kind === 'extracted' ? '🤖 auto' : '✏ manual'}</span>
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

function Kpi({ label, value, tone }: { label: string; value: number; tone: 'gray' | 'red' | 'blue' | 'amber' | 'purple' }) {
  const colors = {
    gray:   'border-gray-800   bg-gray-900',
    red:    'border-red-800/40 bg-red-500/5',
    blue:   'border-blue-800/40 bg-blue-500/5',
    amber:  'border-amber-800/40 bg-amber-500/5',
    purple: 'border-purple-800/40 bg-purple-500/5',
  }[tone]
  return (
    <div className={`rounded-lg border ${colors} p-3`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-xl font-bold text-white mt-0.5">{value}</p>
    </div>
  )
}
