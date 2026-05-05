'use client'

import { useState, useEffect, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type KBCategory = 'brand' | 'category' | 'platform' | 'usp'

interface KBItem {
  id: string
  category: KBCategory
  name: string
  data: Record<string, unknown>
  created_at: string
  updated_at: string
}

interface DmcaTerm {
  id: string
  original_term: string
  replacement_term: string
  notes: string | null
  active: boolean
  created_at: string
}

interface ScanResult {
  scanned: number
  terms: number
  hits: number
  resolved: number
}

interface BrandHtmlFormat {
  h1?:     string   // wrapper, use {text} as placeholder
  h2?:     string
  h3?:     string
  h4?:     string
  p?:      string   // paragraph wrapper (G2G: just `{text}<br><br>`)
  ul?:     string   // unordered list wrapper (Bragi inserts <li> children)
  ol?:     string
  li?:     string
  strong?: string
  em?:     string
  a?:      string   // link wrapper, use {href} and {text}
}

interface BrandData {
  tone?:        string
  audience?:    string
  dos?:         string[]
  donts?:       string[]
  notes?:       string
  // CMS-specific HTML wrapping. When set, brief assembly outputs HTML using
  // these templates (one source of truth) instead of vanilla markdown.
  // {text} = inner content; {href} for links.
  html_format?: BrandHtmlFormat
}

// Sensible G2G defaults — Quasar-style class names matching their CMS preview.
// Drop the Vue-scoped data-v-* attributes (those are runtime-rendered by CMS).
const DEFAULT_HTML_FORMAT: BrandHtmlFormat = {
  h1:     '<h1 class="text-h4 q-ma-none">{text}</h1>',
  h2:     '<h2 class="text-h4 q-ma-none">{text}</h2>',
  h3:     '<h3 class="text-h6 q-ma-none">{text}</h3>',
  h4:     '<h4 class="text-subtitle1 q-ma-none">{text}</h4>',
  p:      '{text}<br><br>',
  ul:     '<ul>{text}</ul>',
  ol:     '<ol>{text}</ol>',
  li:     '<li>{text}</li>',
  strong: '<strong>{text}</strong>',
  em:     '<em>{text}</em>',
  a:      '<a href="{href}">{text}</a>',
}

interface CategoryData {
  description?: string
  buyer_intent?: string
  keywords?: string[]          // SEO Search Terms
  content_angles?: string[]    // dedicated Content Angle section (multi-line)
  notes?: string
}

interface PlatformData {
  writing_rules?: string
  format?: string
  tone?: string
  dos?: string[]
  donts?: string[]
  notes?: string
}

interface UspData {
  description?: string
  applicable_category_ids?: string[]
  usage_type?: 'on_page' | 'off_page' | 'both'
}

// ─── Shared field components ──────────────────────────────────────────────────

function ArrayField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  rows?: number
}) {
  const text = (value ?? []).join('\n')
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      <textarea
        rows={rows}
        value={text}
        onChange={e => onChange(e.target.value.split('\n'))}
        placeholder={placeholder ?? 'One item per line'}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
      />
    </div>
  )
}

function TextField({
  label,
  value,
  onChange,
  rows = 2,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      {rows === 1 ? (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
      ) : (
        <textarea
          rows={rows}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
        />
      )}
    </div>
  )
}

// ─── Brand Tab ────────────────────────────────────────────────────────────────

function BrandTab({ items, onRefresh }: { items: KBItem[]; onRefresh: () => void }) {
  const existing = items.find(i => i.category === 'brand')
  const [data, setData] = useState<BrandData>(
    (existing?.data as BrandData) ?? { tone: '', audience: '', dos: [], donts: [], notes: '' }
  )
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (existing) setData(existing.data as BrandData)
  }, [existing?.id]) // eslint-disable-line

  async function handleSuggest() {
    setSuggesting(true)
    try {
      const res = await fetch('/api/knowledge-base/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'brand', site_url: 'https://www.g2g.com' }),
      })
      const json = await res.json()
      if (json.suggestion) setData(json.suggestion as BrandData)
    } catch { /* ignore */ }
    setSuggesting(false)
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (existing) {
        await fetch(`/api/knowledge-base/${existing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        })
      } else {
        await fetch('/api/knowledge-base', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: 'brand', name: 'G2G Brand', data }),
        })
      }
      setSaved(true)
      onRefresh()
      setTimeout(() => setSaved(false), 2000)
    } catch { /* ignore */ }
    setSaving(false)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold">Brand Context</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Defines G2G's tone, audience, and content rules injected into every brief.
          </p>
        </div>
        <button
          onClick={handleSuggest}
          disabled={suggesting}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg transition"
        >
          {suggesting ? <><span className="animate-spin text-base">⟳</span> Generating…</> : <>✨ AI Suggest</>}
        </button>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <TextField
          label="Brand Tone"
          value={data.tone ?? ''}
          onChange={v => setData(d => ({ ...d, tone: v }))}
          rows={2}
          placeholder="e.g. Casual, trustworthy, gamer-friendly. Speaks like a fellow gamer…"
        />
        <TextField
          label="Target Audience"
          value={data.audience ?? ''}
          onChange={v => setData(d => ({ ...d, audience: v }))}
          rows={2}
          placeholder="e.g. Online gamers aged 16–35 who play MMORPGs and mobile games…"
        />
        <div className="grid grid-cols-2 gap-4">
          <ArrayField
            label="DOs — always do in content"
            value={data.dos ?? []}
            onChange={v => setData(d => ({ ...d, dos: v }))}
            placeholder={"Mention fast delivery\nHighlight buyer protection\n…"}
          />
          <ArrayField
            label="DON'Ts — avoid in content"
            value={data.donts ?? []}
            onChange={v => setData(d => ({ ...d, donts: v }))}
            placeholder={"Use aggressive pricing claims\nPromise unrealistic delivery\n…"}
          />
        </div>
        <TextField
          label="Additional Notes"
          value={data.notes ?? ''}
          onChange={v => setData(d => ({ ...d, notes: v }))}
          rows={2}
          placeholder="Any other brand context for content writers…"
        />
      </div>

      {/* HTML Output Template — controls how Bragi wraps the assembled article.
          Set once here, applies to all final_content output (and translations).
          Use {text} as the inner-content placeholder; {href} for links. */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-white font-semibold text-sm">🎨 HTML Output Template</h3>
            <p className="text-gray-500 text-xs mt-0.5">
              Bragi wraps each markdown element with these templates when generating final content. Use <code className="text-yellow-400">{'{text}'}</code> for the inner content and <code className="text-yellow-400">{'{href}'}</code> for link URLs. Leave blank to use plain markdown.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setData(d => ({ ...d, html_format: { ...DEFAULT_HTML_FORMAT } }))}
            className="text-xs text-blue-400 hover:text-blue-300 transition"
          >
            ↻ Reset to G2G defaults
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {(['h1','h2','h3','h4','p','ul','ol','li','strong','em','a'] as const).map(tag => (
            <div key={tag}>
              <label className="block text-xs font-mono text-gray-400 mb-1">&lt;{tag}&gt;</label>
              <input
                type="text"
                value={data.html_format?.[tag] ?? ''}
                onChange={e => setData(d => ({
                  ...d,
                  html_format: { ...(d.html_format ?? {}), [tag]: e.target.value },
                }))}
                placeholder={DEFAULT_HTML_FORMAT[tag] ?? ''}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono placeholder-gray-600 focus:outline-none focus:border-red-500"
              />
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
      >
        {saving ? 'Saving…' : saved ? '✓ Saved!' : 'Save Brand Context'}
      </button>
    </div>
  )
}

// ─── Category Item Form ───────────────────────────────────────────────────────

function CategoryItemForm({
  item,
  onSave,
  onDelete,
}: {
  item: KBItem
  onSave: (id: string, name: string, data: CategoryData) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [name, setName] = useState(item.name)
  const [data, setData] = useState<CategoryData>(item.data as CategoryData)
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [open, setOpen] = useState(false)

  async function handleSuggest() {
    setSuggesting(true)
    try {
      const res = await fetch('/api/knowledge-base/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'category', name }),
      })
      const json = await res.json()
      if (json.suggestion) setData(json.suggestion as CategoryData)
    } catch { /* ignore */ }
    setSuggesting(false)
  }

  async function handleSave() {
    setSaving(true)
    await onSave(item.id, name, data)
    setSaving(false)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition text-left"
      >
        <span className="text-white font-medium text-sm">{item.name}</span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800 pt-4">
          <TextField
            label="Category Name"
            value={name}
            onChange={setName}
            rows={1}
            placeholder="e.g. Top Up, Currency, Accounts"
          />
          <TextField
            label="Description"
            value={data.description ?? ''}
            onChange={v => setData(d => ({ ...d, description: v }))}
            rows={2}
            placeholder="What is this product category on G2G?"
          />
          <TextField
            label="Buyer Intent"
            value={data.buyer_intent ?? ''}
            onChange={v => setData(d => ({ ...d, buyer_intent: v }))}
            rows={2}
            placeholder="Transactional? Informational? Specific game?"
          />

          {/* SEO Search Terms (renamed from Keywords) */}
          <ArrayField
            label="SEO Search Terms (one per line)"
            value={data.keywords ?? []}
            onChange={v => setData(d => ({ ...d, keywords: v }))}
            placeholder={"buy mobile legends diamonds\ncheap in-game currency\nml diamond top up\n…"}
          />

          {/* Content Angle — dedicated section */}
          <div className="rounded-xl border border-indigo-800/50 bg-indigo-950/30 p-4 space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-indigo-400 text-sm">🎯</span>
              <p className="text-indigo-300 text-xs font-semibold uppercase tracking-wider">Content Angles</p>
            </div>
            <p className="text-gray-500 text-xs mb-2">
              The strategic angles writers should use for this category (one per line). e.g. "Safety & buyer protection", "Fastest delivery guarantee", "Price comparison vs competitors"
            </p>
            <textarea
              rows={4}
              value={(data.content_angles ?? []).join('\n')}
              onChange={e => setData(d => ({ ...d, content_angles: e.target.value.split('\n') }))}
              placeholder={"Safety & buyer protection\nFastest delivery guarantee\nPrice comparison vs competitors\n…"}
              className="w-full bg-gray-800 border border-indigo-800/40 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          <TextField
            label="Notes"
            value={data.notes ?? ''}
            onChange={v => setData(d => ({ ...d, notes: v }))}
            rows={2}
            placeholder="Special considerations…"
          />

          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              <button
                onClick={handleSuggest}
                disabled={suggesting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg transition"
              >
                {suggesting ? '⟳ Generating…' : '✨ AI Suggest'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <button
              onClick={() => onDelete(item.id)}
              className="text-xs text-gray-500 hover:text-red-400 transition"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Categories Tab ───────────────────────────────────────────────────────────

function CategoriesTab({ items, onRefresh }: { items: KBItem[]; onRefresh: () => void }) {
  const categoryItems = items.filter(i => i.category === 'category')
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    await fetch('/api/knowledge-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'category', name: newName.trim(), data: {} }),
    })
    setNewName('')
    setAdding(false)
    onRefresh()
  }

  async function handleSave(id: string, name: string, data: CategoryData) {
    await fetch(`/api/knowledge-base/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data }),
    })
    onRefresh()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this category?')) return
    await fetch(`/api/knowledge-base/${id}`, { method: 'DELETE' })
    onRefresh()
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-white font-semibold">Product Categories</h2>
        <p className="text-gray-400 text-sm mt-0.5">
          Per-category context injected when generating briefs. SEO Search Terms = keyword variants for that category (e.g. "Buy WoW Gold", "Cheap WoW Gold").
        </p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="New category name (e.g. Top Up, Currency, Accounts)…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newName.trim()}
          className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
        >
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>

      {categoryItems.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No categories yet. Add one above.</p>
      ) : (
        <div className="space-y-2">
          {categoryItems.map(item => (
            <CategoryItemForm
              key={item.id}
              item={item}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Platform Item Form ───────────────────────────────────────────────────────

function PlatformItemForm({
  item,
  onSave,
  onDelete,
}: {
  item: KBItem
  onSave: (id: string, name: string, data: PlatformData) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [name, setName] = useState(item.name)
  const [data, setData] = useState<PlatformData>(item.data as PlatformData)
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [open, setOpen] = useState(false)

  async function handleSuggest() {
    setSuggesting(true)
    try {
      const res = await fetch('/api/knowledge-base/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'platform', name }),
      })
      const json = await res.json()
      if (json.suggestion) setData(json.suggestion as PlatformData)
    } catch { /* ignore */ }
    setSuggesting(false)
  }

  async function handleSave() {
    setSaving(true)
    await onSave(item.id, name, data)
    setSaving(false)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition text-left"
      >
        <span className="text-white font-medium text-sm">{item.name}</span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800 pt-4">
          <TextField
            label="Platform Name"
            value={name}
            onChange={setName}
            rows={1}
            placeholder="e.g. Reddit, Medium, Substack"
          />
          <TextField
            label="Writing Rules"
            value={data.writing_rules ?? ''}
            onChange={v => setData(d => ({ ...d, writing_rules: v }))}
            rows={2}
            placeholder="Core rules for writing on this platform"
          />
          <TextField
            label="Format"
            value={data.format ?? ''}
            onChange={v => setData(d => ({ ...d, format: v }))}
            rows={2}
            placeholder="Ideal length, structure, use of lists/paragraphs"
          />
          <TextField
            label="Tone"
            value={data.tone ?? ''}
            onChange={v => setData(d => ({ ...d, tone: v }))}
            rows={1}
            placeholder="Appropriate tone for this platform"
          />
          <div className="grid grid-cols-2 gap-4">
            <ArrayField
              label="DOs"
              value={data.dos ?? []}
              onChange={v => setData(d => ({ ...d, dos: v }))}
              placeholder={"Use storytelling\nLink to sources\n…"}
            />
            <ArrayField
              label="DON'Ts"
              value={data.donts ?? []}
              onChange={v => setData(d => ({ ...d, donts: v }))}
              placeholder={"Over-promote\nPost thin content\n…"}
            />
          </div>
          <TextField
            label="Notes"
            value={data.notes ?? ''}
            onChange={v => setData(d => ({ ...d, notes: v }))}
            rows={2}
            placeholder="Platform-specific notes about posting, visibility, community rules…"
          />

          <div className="flex items-center justify-between pt-1">
            <div className="flex gap-2">
              <button
                onClick={handleSuggest}
                disabled={suggesting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white rounded-lg transition"
              >
                {suggesting ? '⟳ Generating…' : '✨ AI Suggest'}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <button
              onClick={() => onDelete(item.id)}
              className="text-xs text-gray-500 hover:text-red-400 transition"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Platforms Tab ────────────────────────────────────────────────────────────

function PlatformsTab({ items, onRefresh }: { items: KBItem[]; onRefresh: () => void }) {
  const platformItems = items.filter(i => i.category === 'platform')
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    await fetch('/api/knowledge-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'platform', name: newName.trim(), data: {} }),
    })
    setNewName('')
    setAdding(false)
    onRefresh()
  }

  async function handleSave(id: string, name: string, data: PlatformData) {
    await fetch(`/api/knowledge-base/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data }),
    })
    onRefresh()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this platform?')) return
    await fetch(`/api/knowledge-base/${id}`, { method: 'DELETE' })
    onRefresh()
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-white font-semibold">Platforms</h2>
        <p className="text-gray-400 text-sm mt-0.5">
          Writing rules per distribution platform (Reddit, Medium, Substack, etc.).
        </p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="New platform name (e.g. Reddit, Medium)…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newName.trim()}
          className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
        >
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>

      {platformItems.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No platforms yet. Add one above.</p>
      ) : (
        <div className="space-y-2">
          {platformItems.map(item => (
            <PlatformItemForm
              key={item.id}
              item={item}
              onSave={handleSave}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── USP Item Form ────────────────────────────────────────────────────────────

function UspItemForm({
  item,
  categoryItems,
  onSave,
  onDelete,
}: {
  item: KBItem
  categoryItems: KBItem[]
  onSave: (id: string, name: string, data: UspData) => Promise<void>
  onDelete: (id: string) => Promise<void>
}) {
  const [name, setName] = useState(item.name)
  const [data, setData] = useState<UspData>(item.data as UspData)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  function toggleCategory(catId: string) {
    const current = data.applicable_category_ids ?? []
    const updated = current.includes(catId)
      ? current.filter(id => id !== catId)
      : [...current, catId]
    setData(d => ({ ...d, applicable_category_ids: updated }))
  }

  async function handleSave() {
    setSaving(true)
    await onSave(item.id, name, data)
    setSaving(false)
  }

  const selectedCount = (data.applicable_category_ids ?? []).length

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800 transition text-left"
      >
        <div className="flex items-center gap-3">
          <span className="text-white font-medium text-sm">{item.name}</span>
          {selectedCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-700/40 text-amber-300 border border-amber-700/50">
              {selectedCount} {selectedCount === 1 ? 'category' : 'categories'}
            </span>
          )}
        </div>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-gray-800 pt-4">
          <TextField
            label="USP Name"
            value={name}
            onChange={setName}
            rows={1}
            placeholder="e.g. Fastest Delivery, Buyer Protection, Lowest Price Guarantee"
          />
          {/* Usage type */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">Usage</label>
            <div className="flex gap-2">
              {(['on_page', 'off_page', 'both'] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setData(d => ({ ...d, usage_type: t }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    (data.usage_type ?? 'on_page') === t
                      ? t === 'on_page' ? 'bg-blue-800/50 border-blue-500 text-blue-300'
                        : t === 'off_page' ? 'bg-purple-800/50 border-purple-500 text-purple-300'
                        : 'bg-gray-700 border-gray-400 text-gray-200'
                      : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
                  }`}
                >
                  {t === 'on_page' ? '📄 On-page' : t === 'off_page' ? '🔗 Off-page' : '✦ Both'}
                </button>
              ))}
            </div>
          </div>

          <TextField
            label="Description"
            value={data.description ?? ''}
            onChange={v => setData(d => ({ ...d, description: v }))}
            rows={3}
            placeholder="Explain this unique selling point — what it means for buyers and how writers should convey it…"
          />

          {/* Category checkboxes */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-2">
              Applies to Categories
            </label>
            {categoryItems.length === 0 ? (
              <p className="text-gray-600 text-xs italic">No categories defined yet — add them in the Categories tab.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {categoryItems.map(cat => {
                  const checked = (data.applicable_category_ids ?? []).includes(cat.id)
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => toggleCategory(cat.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                        checked
                          ? 'bg-amber-700/30 border-amber-600 text-amber-300'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                      }`}
                    >
                      <span>{checked ? '✓' : '+'}</span>
                      {cat.name}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => onDelete(item.id)}
              className="text-xs text-gray-500 hover:text-red-400 transition"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── USP Tab ──────────────────────────────────────────────────────────────────

function UspTab({ items, onRefresh }: { items: KBItem[]; onRefresh: () => void }) {
  const uspItems      = items.filter(i => i.category === 'usp')
  const categoryItems = items.filter(i => i.category === 'category')
  const [newName, setNewName]   = useState('')
  const [newUsage, setNewUsage] = useState<'on_page' | 'off_page' | 'both'>('on_page')
  const [adding, setAdding]     = useState(false)

  const onPageItems  = uspItems.filter(i => {
    const t = (i.data as UspData).usage_type ?? 'on_page'
    return t === 'on_page' || t === 'both'
  })
  const offPageItems = uspItems.filter(i => {
    const t = (i.data as UspData).usage_type ?? 'on_page'
    return t === 'off_page' || t === 'both'
  })

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    await fetch('/api/knowledge-base', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category: 'usp', name: newName.trim(), data: { applicable_category_ids: [], usage_type: newUsage } }),
    })
    setNewName('')
    setAdding(false)
    onRefresh()
  }

  async function handleSave(id: string, name: string, data: UspData) {
    await fetch(`/api/knowledge-base/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, data }),
    })
    onRefresh()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this USP?')) return
    await fetch(`/api/knowledge-base/${id}`, { method: 'DELETE' })
    onRefresh()
  }

  function UspSection({ title, badge, badgeColor, sectionItems, empty }: {
    title: string; badge: string; badgeColor: string; sectionItems: KBItem[]; empty: string
  }) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <h3 className="text-white font-medium text-sm">{title}</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>{badge}</span>
          <span className="text-gray-600 text-xs">{sectionItems.length} USPs</span>
        </div>
        {sectionItems.length === 0 ? (
          <p className="text-gray-600 text-xs italic px-1 mb-2">{empty}</p>
        ) : (
          <div className="space-y-2 mb-2">
            {sectionItems.map(item => (
              <UspItemForm key={item.id} item={item} categoryItems={categoryItems} onSave={handleSave} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-white font-semibold">Unique Selling Points (USPs)</h2>
        <p className="text-gray-400 text-sm mt-0.5">
          USPs injected into AI content generation. Use <code className="bg-gray-800 px-1 rounded text-yellow-400 text-xs">&#123;usps&#125;</code> in Prompt Templates to auto-insert on-page USPs.
        </p>
      </div>

      {/* Add new */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="New USP name (e.g. GamerProtect, Fastest Delivery)…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <select
          value={newUsage}
          onChange={e => setNewUsage(e.target.value as 'on_page' | 'off_page' | 'both')}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
        >
          <option value="on_page">📄 On-page</option>
          <option value="off_page">🔗 Off-page</option>
          <option value="both">✦ Both</option>
        </select>
        <button onClick={handleAdd} disabled={adding || !newName.trim()}
          className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition">
          {adding ? 'Adding…' : '+ Add'}
        </button>
      </div>

      {uspItems.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No USPs yet. Add one above.</p>
      ) : (
        <div className="space-y-6">
          <UspSection
            title="On-page USPs"
            badge="📄 On-page"
            badgeColor="bg-blue-900/50 text-blue-300"
            sectionItems={onPageItems}
            empty="No on-page USPs yet. Add one above with type 'On-page'."
          />
          <div className="border-t border-gray-800" />
          <UspSection
            title="Off-page USPs"
            badge="🔗 Off-page"
            badgeColor="bg-purple-900/50 text-purple-300"
            sectionItems={offPageItems}
            empty="No off-page USPs yet. Add one above with type 'Off-page'."
          />
        </div>
      )}
    </div>
  )
}

// ─── DMCA Terms Tab ───────────────────────────────────────────────────────────

function DmcaTab() {
  const [terms, setTerms] = useState<DmcaTerm[]>([])
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [newOriginal, setNewOriginal] = useState('')
  const [newReplacement, setNewReplacement] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [adding, setAdding] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)

  const fetchTerms = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/dmca')
    const json = await res.json()
    setTerms(json.terms ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchTerms() }, [fetchTerms])

  async function handleAdd() {
    if (!newOriginal.trim() || !newReplacement.trim()) return
    setAdding(true)
    await fetch('/api/dmca', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original_term:    newOriginal.trim(),
        replacement_term: newReplacement.trim(),
        notes:            newNotes.trim() || undefined,
      }),
    })
    setNewOriginal(''); setNewReplacement(''); setNewNotes('')
    setAdding(false)
    fetchTerms()
  }

  async function handleToggleActive(term: DmcaTerm) {
    await fetch(`/api/dmca/${term.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !term.active }),
    })
    fetchTerms()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this DMCA term?')) return
    await fetch(`/api/dmca/${id}`, { method: 'DELETE' })
    fetchTerms()
  }

  async function handleScan() {
    setScanning(true)
    setScanResult(null)
    const res = await fetch('/api/dmca/scan', { method: 'POST' })
    const json = await res.json()
    setScanResult(json)
    setScanning(false)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-white font-semibold">DMCA / Restricted Terms</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Terms that must be replaced in published content. Scan will flag existing briefs.
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white rounded-lg transition"
        >
          {scanning ? <><span className="animate-spin">⟳</span> Scanning…</> : <>🔍 Scan Published Briefs</>}
        </button>
      </div>

      {scanResult && (
        <div className={`rounded-lg px-4 py-3 text-sm border ${
          scanResult.hits > 0
            ? 'bg-red-900/30 border-red-700 text-red-300'
            : 'bg-green-900/30 border-green-700 text-green-300'
        }`}>
          {scanResult.hits > 0 ? (
            <>⚠️ Found <strong>{scanResult.hits}</strong> flagged term{scanResult.hits !== 1 ? 's' : ''} across <strong>{scanResult.scanned}</strong> published briefs. Go to Notifications to review.</>
          ) : (
            <>✓ All clear — scanned {scanResult.scanned} published briefs, no restricted terms found.{scanResult.resolved > 0 && ` (${scanResult.resolved} previously flagged items resolved)`}</>
          )}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Add Term</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Original Term (to avoid)</label>
            <input
              type="text"
              value={newOriginal}
              onChange={e => setNewOriginal(e.target.value)}
              placeholder="e.g. hack, exploit, cheat"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Replacement Term</label>
            <input
              type="text"
              value={newReplacement}
              onChange={e => setNewReplacement(e.target.value)}
              placeholder="e.g. boost, optimize, enhance"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>
        <input
          type="text"
          value={newNotes}
          onChange={e => setNewNotes(e.target.value)}
          placeholder="Notes (optional)…"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newOriginal.trim() || !newReplacement.trim()}
          className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white rounded-lg transition"
        >
          {adding ? 'Adding…' : '+ Add Term'}
        </button>
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm text-center py-8">Loading…</p>
      ) : terms.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No DMCA terms yet.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Original Term</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Replace With</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden md:table-cell">Notes</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Active</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {terms.map((term, i) => (
                <tr key={term.id} className={`border-b border-gray-800 last:border-0 ${i % 2 === 0 ? '' : 'bg-gray-800/30'}`}>
                  {editId === term.id ? (
                    <EditTermRow
                      term={term}
                      onSave={async (patch) => {
                        await fetch(`/api/dmca/${term.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(patch),
                        })
                        setEditId(null)
                        fetchTerms()
                      }}
                      onCancel={() => setEditId(null)}
                    />
                  ) : (
                    <>
                      <td className="px-4 py-3 text-white font-mono">{term.original_term}</td>
                      <td className="px-4 py-3 text-green-400 font-mono">{term.replacement_term}</td>
                      <td className="px-4 py-3 text-gray-400 hidden md:table-cell">{term.notes ?? '—'}</td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(term)}
                          className={`w-8 h-4 rounded-full transition-colors ${term.active ? 'bg-green-600' : 'bg-gray-600'}`}
                          title={term.active ? 'Active — click to disable' : 'Inactive — click to enable'}
                        >
                          <span className={`block w-3 h-3 bg-white rounded-full transition-transform mx-0.5 ${term.active ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button onClick={() => setEditId(term.id)} className="text-xs text-gray-400 hover:text-white transition">Edit</button>
                          <button onClick={() => handleDelete(term.id)} className="text-xs text-gray-500 hover:text-red-400 transition">Del</button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function EditTermRow({
  term, onSave, onCancel,
}: {
  term: DmcaTerm
  onSave: (patch: Partial<DmcaTerm>) => Promise<void>
  onCancel: () => void
}) {
  const [original, setOriginal]       = useState(term.original_term)
  const [replacement, setReplacement] = useState(term.replacement_term)
  const [notes, setNotes]             = useState(term.notes ?? '')
  const [saving, setSaving]           = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave({ original_term: original, replacement_term: replacement, notes: notes || null })
    setSaving(false)
  }

  return (
    <>
      <td className="px-4 py-2">
        <input value={original} onChange={e => setOriginal(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-red-500" />
      </td>
      <td className="px-4 py-2">
        <input value={replacement} onChange={e => setReplacement(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-green-500" />
      </td>
      <td className="px-4 py-2 hidden md:table-cell">
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes…"
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-gray-500" />
      </td>
      <td />
      <td className="px-4 py-2">
        <div className="flex gap-2 justify-end">
          <button onClick={handleSave} disabled={saving} className="text-xs text-green-400 hover:text-green-300 transition">{saving ? '…' : 'Save'}</button>
          <button onClick={onCancel} className="text-xs text-gray-500 hover:text-white transition">Cancel</button>
        </div>
      </td>
    </>
  )
}

// ─── Prompt Templates Tab ─────────────────────────────────────────────────────

interface PromptTemplate {
  id:                    string | null
  category_key:          string
  category_name:         string
  icon:                  string
  url_patterns:          string[]
  h1_template:           string
  meta_title_template:   string
  meta_description_guide: string
  keyword_rules:         string
  writing_rules:         string
  faq_focus:             string
  sections:              { subheading: string; instructions: string }[]
  is_active:             boolean
  is_customized:         boolean
  // True when this entry has no built-in TS default — i.e. it's user-created
  // and can be fully deleted (vs only reset to default).
  is_custom?:            boolean
}

function PromptCard({ prompt, onSaved }: { prompt: PromptTemplate; onSaved: () => void }) {
  const [open,    setOpen]    = useState(false)
  const [form,    setForm]    = useState<PromptTemplate>(prompt)
  const [saving,  setSaving]  = useState(false)
  const [resetting, setResetting] = useState(false)
  const [saved,   setSaved]   = useState(false)

  useEffect(() => { setForm(prompt) }, [prompt.category_key]) // eslint-disable-line

  function updateSection(i: number, key: 'subheading' | 'instructions', val: string) {
    setForm(f => {
      const sections = [...f.sections]
      sections[i] = { ...sections[i], [key]: val }
      return { ...f, sections }
    })
  }

  async function handleSave() {
    setSaving(true)
    await fetch('/api/knowledge-base/prompts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })
    setSaved(true)
    setSaving(false)
    onSaved()
    setTimeout(() => setSaved(false), 2000)
  }

  async function handleReset() {
    const isCustom = !!prompt.is_custom
    const msg = isCustom
      ? `Delete "${prompt.category_name}"? This custom category will be permanently removed.`
      : 'Reset to default? Your customizations will be lost.'
    if (!confirm(msg)) return
    setResetting(true)
    await fetch(`/api/knowledge-base/prompts?category_key=${form.category_key}`, { method: 'DELETE' })
    setResetting(false)
    onSaved()
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      {/* Card header */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">{prompt.icon}</span>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <p className="text-white font-medium text-sm">{prompt.category_name}</p>
              {prompt.is_customized && (
                <span className="text-xs px-1.5 py-0.5 bg-yellow-900 text-yellow-300 rounded">Customized</span>
              )}
            </div>
            <p className="text-gray-500 text-xs mt-0.5">
              {prompt.sections.length} sections · URL patterns: {prompt.url_patterns.join(', ')}
            </p>
          </div>
        </div>
        <svg className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-800 pt-4 space-y-4">
          {/* Meta fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">H1 Template</label>
              <input value={form.h1_template} onChange={e => setForm(f => ({ ...f, h1_template: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Meta Title Template</label>
              <input value={form.meta_title_template} onChange={e => setForm(f => ({ ...f, meta_title_template: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Meta Description Guide</label>
            <input value={form.meta_description_guide} onChange={e => setForm(f => ({ ...f, meta_description_guide: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Keyword Rules</label>
              <textarea value={form.keyword_rules} onChange={e => setForm(f => ({ ...f, keyword_rules: e.target.value }))}
                rows={3} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">FAQ Focus</label>
              <textarea value={form.faq_focus} onChange={e => setForm(f => ({ ...f, faq_focus: e.target.value }))}
                rows={3} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Writing Rules</label>
            <textarea value={form.writing_rules} onChange={e => setForm(f => ({ ...f, writing_rules: e.target.value }))}
              rows={4} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
          </div>

          {/* Sections */}
          <div>
            <label className="block text-xs text-gray-400 mb-2">Content Sections ({form.sections.length})</label>
            <div className="space-y-3">
              {form.sections.map((sec, i) => (
                <div key={i} className="bg-gray-800 rounded-lg p-3 space-y-2">
                  <input
                    value={sec.subheading}
                    onChange={e => updateSection(i, 'subheading', e.target.value)}
                    placeholder="H2 subheading template"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-red-500"
                  />
                  <textarea
                    value={sec.instructions}
                    onChange={e => updateSection(i, 'instructions', e.target.value)}
                    rows={3}
                    placeholder="Section writing instructions"
                    className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-red-500 resize-none"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Sections — Add / remove */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setForm(f => ({
                ...f,
                sections: [...f.sections, { subheading: '', instructions: '' }],
              }))}
              className="text-xs text-blue-400 hover:text-blue-300 transition"
            >
              + Add section
            </button>
            {form.sections.length > 0 && (
              <button
                type="button"
                onClick={() => setForm(f => ({ ...f, sections: f.sections.slice(0, -1) }))}
                className="text-xs text-gray-500 hover:text-red-400 transition"
              >
                – Remove last
              </button>
            )}
          </div>

          {/* URL patterns + actions */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">URL Patterns (comma-separated)</label>
            <input
              value={form.url_patterns.join(', ')}
              onChange={e => setForm(f => ({
                ...f,
                url_patterns: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
              }))}
              placeholder="account, accounts, profile"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
            />
            <p className="text-[10px] text-gray-500 mt-1">URL fragments that auto-match this prompt to a page (e.g., /buy-fifa-account → matches &quot;account&quot;)</p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between pt-2">
            {prompt.is_customized ? (
              <button onClick={handleReset} disabled={resetting}
                className={`text-xs transition disabled:opacity-50 ${prompt.is_custom ? 'text-red-500 hover:text-red-300' : 'text-gray-500 hover:text-red-400'}`}>
                {resetting ? '…' : prompt.is_custom ? '🗑 Delete category' : '↩ Reset to default'}
              </button>
            ) : <div />}
            <button onClick={handleSave} disabled={saving}
              className="px-4 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm rounded-lg transition">
              {saved ? '✓ Saved' : saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function slugifyKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function AddCustomCategoryForm({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [name,        setName]        = useState('')
  const [icon,        setIcon]        = useState('🆕')
  const [urls,        setUrls]        = useState('')
  const [h1,          setH1]          = useState('Buy {mainKeyword} - Fast Delivery, 24/7 Support | G2G.com')
  const [metaTitle,   setMetaTitle]   = useState('Buy {mainKeyword} - G2G.com (≤60 chars)')
  const [metaDesc,    setMetaDesc]    = useState('≤110 chars. Include benefit + 3 trust terms.')
  const [keywordRules, setKeywordRules] = useState('Main keyword: 1%–4% density. Secondary keywords: ≤2%, appear at least once.')
  const [writingRules, setWritingRules] = useState('Natural, helpful tone. Use <br><br> between paragraphs (no <p> tags). Avoid filler words.')
  const [faqFocus,    setFaqFocus]    = useState('Transaction safety, delivery, refunds, seller verification.')
  const [sections,    setSections]    = useState<{ subheading: string; instructions: string }[]>([
    { subheading: 'Buy {mainKeyword} — Overview', instructions: '~250 words, 3+ paragraphs explaining what users gain.' },
    { subheading: 'Why Buy {mainKeyword} on G2G', instructions: '3 paragraphs covering GamerProtect escrow, ISO/IEC 27001:2013 security, 24/7 support.' },
    { subheading: 'How to Buy {mainKeyword}', instructions: 'Ordered list of buy steps from search to delivery confirmation.' },
    { subheading: 'FAQ', instructions: '3–5 FAQs from People Also Ask. Focus on safety, delivery, refunds.' },
  ])
  const [saving,      setSaving]      = useState(false)
  const [error,       setError]       = useState<string | null>(null)

  const key = slugifyKey(name)
  const valid = name.trim().length >= 3 && key.length > 0

  function updateSection(i: number, field: 'subheading' | 'instructions', val: string) {
    setSections(s => { const next = [...s]; next[i] = { ...next[i], [field]: val }; return next })
  }

  async function handleSubmit() {
    if (!valid) { setError('Category name must be at least 3 characters'); return }
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/knowledge-base/prompts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          category_key:           key,
          category_name:          name.trim(),
          icon,
          url_patterns:           urls.split(',').map(s => s.trim()).filter(Boolean),
          h1_template:            h1,
          meta_title_template:    metaTitle,
          meta_description_guide: metaDesc,
          keyword_rules:          keywordRules,
          writing_rules:          writingRules,
          faq_focus:              faqFocus,
          sections:               sections.filter(s => s.subheading.trim() || s.instructions.trim()),
          is_active:              true,
        }),
      })
      const data = await res.json() as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-gray-900 border border-blue-500/30 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold text-sm">+ New Custom Category</h3>
        <button onClick={onCancel} className="text-gray-500 hover:text-white text-xs transition">✕ Cancel</button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-300">⚠️ {error}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2">
          <label className="block text-xs text-gray-400 mb-1">Category Name *</label>
          <input value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. NFT/Crypto Items, VPN Services, Robux Items"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
          {key && <p className="text-[10px] text-gray-500 mt-1">key: <code className="text-yellow-400">{key}</code></p>}
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Icon (emoji)</label>
          <input value={icon} onChange={e => setIcon(e.target.value.slice(0, 4))}
            placeholder="🆕"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-2xl text-center text-white focus:outline-none focus:border-red-500" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">URL Patterns (comma-separated)</label>
        <input value={urls} onChange={e => setUrls(e.target.value)}
          placeholder="e.g. nft, crypto, items"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
        <p className="text-[10px] text-gray-500 mt-1">URL fragments that auto-match this template (e.g., /buy-nft-collectibles → matches &quot;nft&quot;).</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">H1 Template</label>
          <input value={h1} onChange={e => setH1(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Meta Title Template</label>
          <input value={metaTitle} onChange={e => setMetaTitle(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Meta Description Guide</label>
        <input value={metaDesc} onChange={e => setMetaDesc(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Keyword Rules</label>
          <textarea value={keywordRules} onChange={e => setKeywordRules(e.target.value)}
            rows={3} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">FAQ Focus</label>
          <textarea value={faqFocus} onChange={e => setFaqFocus(e.target.value)}
            rows={3} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Writing Rules</label>
        <textarea value={writingRules} onChange={e => setWritingRules(e.target.value)}
          rows={3} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs text-gray-400">Content Sections ({sections.length})</label>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => setSections(s => [...s, { subheading: '', instructions: '' }])}
              className="text-xs text-blue-400 hover:text-blue-300 transition">+ Add</button>
            {sections.length > 0 && (
              <button type="button"
                onClick={() => setSections(s => s.slice(0, -1))}
                className="text-xs text-gray-500 hover:text-red-400 transition">– Remove last</button>
            )}
          </div>
        </div>
        <div className="space-y-3">
          {sections.map((sec, i) => (
            <div key={i} className="bg-gray-800 rounded-lg p-3 space-y-2">
              <input value={sec.subheading} onChange={e => updateSection(i, 'subheading', e.target.value)}
                placeholder="H2 subheading template (use {mainKeyword}, {gameName})"
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-red-500" />
              <textarea value={sec.instructions} onChange={e => updateSection(i, 'instructions', e.target.value)}
                rows={2}
                placeholder="Section writing instructions"
                className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:border-red-500 resize-none" />
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-800">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition">Cancel</button>
        <button onClick={handleSubmit} disabled={!valid || saving}
          className="px-4 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition">
          {saving ? 'Saving…' : '✓ Create Category'}
        </button>
      </div>
    </div>
  )
}

function PromptsTab() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const fetchPrompts = useCallback(async () => {
    const res = await fetch('/api/knowledge-base/prompts')
    const d = await res.json()
    setPrompts(d.prompts ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchPrompts() }, [fetchPrompts])

  const customized = prompts.filter(p => p.is_customized).length
  const customCount = prompts.filter(p => p.is_custom).length

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-white font-semibold">Prompt Templates</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Master Prompt List — writing instructions per product category, used by Bragi (brief generation), auto product content sync, and Content Studio.
            {customized > 0 && <span className="ml-2 text-yellow-400">{customized} customized</span>}
            {customCount > 0 && <span className="ml-2 text-blue-400">{customCount} custom</span>}
          </p>
        </div>
        <button
          onClick={() => setAddOpen(o => !o)}
          className="px-3 py-1.5 text-sm rounded-lg bg-red-600 hover:bg-red-700 text-white transition flex-shrink-0"
        >
          {addOpen ? '✕ Close' : '+ Add Custom Category'}
        </button>
      </div>

      {addOpen && (
        <AddCustomCategoryForm
          onCancel={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); fetchPrompts() }}
        />
      )}

      {/* Available placeholders */}
      <div className="bg-gray-900 border border-yellow-800/40 rounded-xl p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-yellow-500 mb-2">Available Placeholders</p>
        <div className="flex flex-wrap gap-2">
          {[
            { ph: '{mainKeyword}',  desc: 'Primary SEO keyword being targeted' },
            { ph: '{gameName}',     desc: 'Game or product name extracted from URL' },
            { ph: '{productName}',  desc: 'Alias for gameName' },
            { ph: '{usps}',         desc: 'On-page USPs from Knowledge Base (auto-injected)' },
          ].map(({ ph, desc }) => (
            <span key={ph} className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs" title={desc}>
              <code className="text-yellow-400">{ph}</code>
              <span className="text-gray-500">— {desc}</span>
            </span>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading prompts…</div>
      ) : (
        <div className="space-y-2">
          {prompts.map(p => (
            <PromptCard key={p.category_key} prompt={p} onSaved={fetchPrompts} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = 'brand' | 'categories' | 'usp' | 'platforms' | 'dmca' | 'prompts'

export default function KnowledgeBaseClient() {
  const [activeTab, setActiveTab] = useState<Tab>('brand')
  const [items, setItems]         = useState<KBItem[]>([])
  const [loading, setLoading]     = useState(true)

  const fetchItems = useCallback(async () => {
    const res = await fetch('/api/knowledge-base')
    const json = await res.json()
    setItems(json.items ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchItems() }, [fetchItems])

  const tabs: { key: Tab; label: string; icon: string; badge?: string; badgeColor?: string; count?: number }[] = [
    { key: 'brand',      label: 'Brand',            icon: '🏷️',  badge: 'Both' },
    { key: 'categories', label: 'Categories',       icon: '🗂️',  badge: 'On-page', badgeColor: 'blue', count: items.filter(i => i.category === 'category').length },
    { key: 'usp',        label: 'USPs',             icon: '⭐',  badge: 'Both',                         count: items.filter(i => i.category === 'usp').length },
    { key: 'platforms',  label: 'Platforms',        icon: '📡',  badge: 'Off-page', badgeColor: 'purple', count: items.filter(i => i.category === 'platform').length },
    { key: 'prompts',    label: 'Prompt Templates', icon: '📝',  badge: 'On-page', badgeColor: 'blue' },
    { key: 'dmca',       label: 'DMCA Terms',       icon: '🚫',  badge: 'On-page', badgeColor: 'blue' },
  ]

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🧠 Knowledge Base</h1>
        <p className="text-gray-400 mt-1 text-sm">
          Brand context, category rules, USPs, and platform guidelines injected into all AI content generation.
        </p>
      </div>

      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-6 w-fit flex-wrap">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
              activeTab === tab.key
                ? 'bg-red-700 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
            {tab.badge && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                activeTab === tab.key
                  ? 'bg-red-600/70 text-red-100'
                  : tab.badgeColor === 'blue'   ? 'bg-blue-900/60 text-blue-400'
                  : tab.badgeColor === 'purple' ? 'bg-purple-900/60 text-purple-400'
                  : 'bg-gray-700 text-gray-400'
              }`}>
                {tab.badge}
              </span>
            )}
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${activeTab === tab.key ? 'bg-red-600' : 'bg-gray-700'}`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-500">Loading knowledge base…</div>
      ) : (
        <>
          {activeTab === 'brand'      && <BrandTab      items={items} onRefresh={fetchItems} />}
          {activeTab === 'categories' && <CategoriesTab items={items} onRefresh={fetchItems} />}
          {activeTab === 'usp'        && <UspTab        items={items} onRefresh={fetchItems} />}
          {activeTab === 'platforms'  && <PlatformsTab  items={items} onRefresh={fetchItems} />}
          {activeTab === 'prompts'    && <PromptsTab />}
          {activeTab === 'dmca'       && <DmcaTab />}
        </>
      )}
    </div>
  )
}
