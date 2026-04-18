'use client'

import { useState, useEffect, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type KBCategory = 'brand' | 'category' | 'platform'

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

// ─── Brand data shape ─────────────────────────────────────────────────────────
interface BrandData {
  tone?: string
  audience?: string
  dos?: string[]
  donts?: string[]
  notes?: string
}

// ─── Category data shape ──────────────────────────────────────────────────────
interface CategoryData {
  description?: string
  buyer_intent?: string
  keywords?: string[]
  angle?: string
  notes?: string
}

// ─── Platform data shape ──────────────────────────────────────────────────────
interface PlatformData {
  writing_rules?: string
  format?: string
  tone?: string
  dos?: string[]
  donts?: string[]
  notes?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ArrayField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const text = (value ?? []).join('\n')
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      <textarea
        rows={4}
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
          {suggesting ? (
            <>
              <span className="animate-spin text-base">⟳</span> Generating…
            </>
          ) : (
            <>✨ AI Suggest</>
          )}
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
          <ArrayField
            label="Keywords (one per line)"
            value={data.keywords ?? []}
            onChange={v => setData(d => ({ ...d, keywords: v }))}
            placeholder={"buy mobile legends diamonds\ncheap in-game currency\n…"}
          />
          <TextField
            label="Content Angle"
            value={data.angle ?? ''}
            onChange={v => setData(d => ({ ...d, angle: v }))}
            rows={1}
            placeholder="e.g. Safety/trust, price comparison, fastest delivery"
          />
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
          Per-category context injected when generating briefs for that category.
        </p>
      </div>

      {/* Add new */}
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
    setNewOriginal('')
    setNewReplacement('')
    setNewNotes('')
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
          {scanning ? (
            <><span className="animate-spin">⟳</span> Scanning…</>
          ) : (
            <>🔍 Scan Published Briefs</>
          )}
        </button>
      </div>

      {/* Scan result banner */}
      {scanResult && (
        <div className={`rounded-lg px-4 py-3 text-sm border ${
          scanResult.hits > 0
            ? 'bg-red-900/30 border-red-700 text-red-300'
            : 'bg-green-900/30 border-green-700 text-green-300'
        }`}>
          {scanResult.hits > 0 ? (
            <>
              ⚠️ Found <strong>{scanResult.hits}</strong> flagged term
              {scanResult.hits !== 1 ? 's' : ''} across <strong>{scanResult.scanned}</strong> published
              briefs. Go to <span className="underline cursor-pointer">Notifications</span> to review.
            </>
          ) : (
            <>
              ✓ All clear — scanned {scanResult.scanned} published briefs,
              no restricted terms found.{' '}
              {scanResult.resolved > 0 && `(${scanResult.resolved} previously flagged items resolved)`}
            </>
          )}
        </div>
      )}

      {/* Add new term */}
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

      {/* Terms table */}
      {loading ? (
        <p className="text-gray-500 text-sm text-center py-8">Loading…</p>
      ) : terms.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No DMCA terms yet.</p>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Original Term
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Replace With
                </th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider hidden md:table-cell">
                  Notes
                </th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                  Active
                </th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {terms.map((term, i) => (
                <tr
                  key={term.id}
                  className={`border-b border-gray-800 last:border-0 ${
                    i % 2 === 0 ? '' : 'bg-gray-800/30'
                  }`}
                >
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
                      <td className="px-4 py-3 text-gray-400 hidden md:table-cell">
                        {term.notes ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => handleToggleActive(term)}
                          className={`w-8 h-4 rounded-full transition-colors ${
                            term.active ? 'bg-green-600' : 'bg-gray-600'
                          }`}
                          title={term.active ? 'Active — click to disable' : 'Inactive — click to enable'}
                        >
                          <span
                            className={`block w-3 h-3 bg-white rounded-full transition-transform mx-0.5 ${
                              term.active ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => setEditId(term.id)}
                            className="text-xs text-gray-400 hover:text-white transition"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDelete(term.id)}
                            className="text-xs text-gray-500 hover:text-red-400 transition"
                          >
                            Del
                          </button>
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
  term,
  onSave,
  onCancel,
}: {
  term: DmcaTerm
  onSave: (patch: Partial<DmcaTerm>) => Promise<void>
  onCancel: () => void
}) {
  const [original, setOriginal] = useState(term.original_term)
  const [replacement, setReplacement] = useState(term.replacement_term)
  const [notes, setNotes] = useState(term.notes ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave({
      original_term:    original,
      replacement_term: replacement,
      notes:            notes || null,
    })
    setSaving(false)
  }

  return (
    <>
      <td className="px-4 py-2">
        <input
          value={original}
          onChange={e => setOriginal(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-red-500"
        />
      </td>
      <td className="px-4 py-2">
        <input
          value={replacement}
          onChange={e => setReplacement(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-green-500"
        />
      </td>
      <td className="px-4 py-2 hidden md:table-cell">
        <input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-gray-500"
          placeholder="Notes…"
        />
      </td>
      <td />
      <td className="px-4 py-2">
        <div className="flex gap-2 justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs text-green-400 hover:text-green-300 transition"
          >
            {saving ? '…' : 'Save'}
          </button>
          <button onClick={onCancel} className="text-xs text-gray-500 hover:text-white transition">
            Cancel
          </button>
        </div>
      </td>
    </>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Tab = 'brand' | 'categories' | 'platforms' | 'dmca'

export default function KnowledgeBaseClient() {
  const [activeTab, setActiveTab] = useState<Tab>('brand')
  const [items, setItems] = useState<KBItem[]>([])
  const [loading, setLoading] = useState(true)

  const fetchItems = useCallback(async () => {
    const res = await fetch('/api/knowledge-base')
    const json = await res.json()
    setItems(json.items ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchItems() }, [fetchItems])

  const tabs: { key: Tab; label: string; icon: string; count?: number }[] = [
    { key: 'brand', label: 'Brand', icon: '🏷️' },
    {
      key: 'categories',
      label: 'Categories',
      icon: '🗂️',
      count: items.filter(i => i.category === 'category').length,
    },
    {
      key: 'platforms',
      label: 'Platforms',
      icon: '📡',
      count: items.filter(i => i.category === 'platform').length,
    },
    { key: 'dmca', label: 'DMCA Terms', icon: '🚫' },
  ]

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🧠 Knowledge Base</h1>
        <p className="text-gray-400 mt-1 text-sm">
          Brand context, category rules, and platform guidelines injected into all AI content generation.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-6 w-fit">
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
            {tab.count !== undefined && tab.count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === tab.key ? 'bg-red-600' : 'bg-gray-700'
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {loading ? (
        <div className="text-center py-16 text-gray-500">Loading knowledge base…</div>
      ) : (
        <>
          {activeTab === 'brand'      && <BrandTab      items={items} onRefresh={fetchItems} />}
          {activeTab === 'categories' && <CategoriesTab items={items} onRefresh={fetchItems} />}
          {activeTab === 'platforms'  && <PlatformsTab  items={items} onRefresh={fetchItems} />}
          {activeTab === 'dmca'       && <DmcaTab />}
        </>
      )}
    </div>
  )
}
