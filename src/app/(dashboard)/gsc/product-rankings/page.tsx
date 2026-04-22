'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── CSV Import helpers ─────────────────────────────────────────────────────────

const URL_REMAPS: Record<string, string> = {
  'wow-classic-era-gold': 'wow-classic-era-vanilla-gold',
}

function normalizeProductUrl(raw: string): string | null {
  if (!raw || raw === '-') return null
  try {
    const u = new URL(raw)
    if (u.pathname === '/' || u.pathname.startsWith('/sg')) return null
    const parts = u.pathname.split('/').filter(Boolean)
    const catIdx = parts.indexOf('categories')
    if (catIdx === -1) return null
    const slug = parts[catIdx + 1]
    if (!slug) return null
    const remapped = URL_REMAPS[slug] ?? slug
    return `https://www.g2g.com/categories/${remapped}`
  } catch {
    return null
  }
}

function slugToName(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    const catIdx = parts.indexOf('categories')
    const slug = catIdx >= 0 ? (parts[catIdx + 1] ?? '') : ''
    return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  } catch {
    return url
  }
}

interface ParsedProduct {
  name: string
  page_url: string
  keywords: string[]
}

function parseSemrushCsv(text: string): ParsedProduct[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const headerIdx = lines.findIndex(l => l.startsWith('Keyword,'))
  if (headerIdx === -1) return []
  const headers = lines[headerIdx].split(',')
  const urlIdx = headers.findIndex(h => h.includes('_landing'))
  if (urlIdx === -1) return []

  const grouped = new Map<string, string[]>()
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = lines[i].split(',')
    const keyword = cols[0]?.trim()
    const rawUrl  = cols[urlIdx]?.trim()
    if (!keyword || !rawUrl) continue
    const url = normalizeProductUrl(rawUrl)
    if (!url) continue
    const kws = grouped.get(url) ?? []
    kws.push(keyword)
    grouped.set(url, kws)
  }

  return Array.from(grouped.entries()).map(([url, kws]) => ({
    name: slugToName(url),
    page_url: url,
    keywords: kws,
  }))
}

// ── Import Modal ───────────────────────────────────────────────────────────────

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [parsed,    setParsed]    = useState<ParsedProduct[] | null>(null)
  const [editNames, setEditNames] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [result,    setResult]    = useState<{ inserted: number; skipped: number } | null>(null)
  const [error,     setError]     = useState<string | null>(null)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const products = parseSemrushCsv(text)
      if (products.length === 0) {
        setError("Could not parse CSV — make sure it's a SEMrush Position Tracking export.")
        return
      }
      setParsed(products)
      const names: Record<string, string> = {}
      products.forEach(p => { names[p.page_url] = p.name })
      setEditNames(names)
      setError(null)
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    if (!parsed) return
    setImporting(true); setError(null)
    try {
      const products = parsed.map(p => ({ ...p, name: editNames[p.page_url] ?? p.name }))
      const res = await fetch('/api/products/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Import failed')
      setResult({ inserted: data.inserted, skipped: data.skipped })
    } catch (e) {
      setError(String(e))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">📥 Import from SEMrush CSV</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {!parsed && !result && (
            <div>
              <p className="text-gray-400 text-sm mb-3">
                Upload your <span className="text-white font-medium">SEMrush Position Tracking Rankings Overview</span> CSV.
                Keywords will be automatically grouped by landing URL.
              </p>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
              <button
                onClick={() => fileRef.current?.click()}
                className="border border-dashed border-gray-600 rounded-xl p-8 w-full text-center hover:border-red-500 hover:bg-red-500/5 transition"
              >
                <p className="text-2xl mb-1">📄</p>
                <p className="text-white text-sm font-medium">Click to select CSV file</p>
                <p className="text-gray-600 text-xs mt-0.5">SEMrush position_tracking_rankings_overview export</p>
              </button>
              {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
            </div>
          )}

          {parsed && !result && (
            <div>
              <p className="text-gray-400 text-sm mb-3">
                Found <span className="text-white font-semibold">{parsed.length} products</span>. Edit product names before importing.
              </p>
              <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                {parsed.map(p => (
                  <div key={p.page_url} className="bg-gray-800 rounded-lg px-3 py-2.5 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <input
                        value={editNames[p.page_url] ?? p.name}
                        onChange={e => setEditNames(prev => ({ ...prev, [p.page_url]: e.target.value }))}
                        className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white w-full focus:outline-none focus:border-red-500 mb-1.5"
                      />
                      <p className="text-xs text-blue-400 truncate">{p.page_url}</p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {p.keywords.slice(0, 6).map(kw => (
                          <span key={kw} className="text-xs bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded-full">{kw}</span>
                        ))}
                        {p.keywords.length > 6 && (
                          <span className="text-xs text-gray-500">+{p.keywords.length - 6} more</span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-gray-600 whitespace-nowrap mt-1">{p.keywords.length} kw</span>
                  </div>
                ))}
              </div>
              {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
            </div>
          )}

          {result && (
            <div className="text-center py-6">
              <p className="text-3xl mb-3">✅</p>
              <p className="text-white font-semibold text-lg">{result.inserted} products imported!</p>
              {result.skipped > 0 && (
                <p className="text-gray-400 text-sm mt-1">{result.skipped} skipped (already existed).</p>
              )}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
          {result ? (
            <button onClick={() => { onImported(); onClose() }}
              className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2 rounded-lg transition">
              Done
            </button>
          ) : parsed ? (
            <>
              <button onClick={() => setParsed(null)} className="text-sm text-gray-500 hover:text-gray-300 transition">← Back</button>
              <button onClick={handleImport} disabled={importing}
                className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition">
                {importing ? 'Importing…' : `Import ${parsed.length} products`}
              </button>
            </>
          ) : (
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-300 transition">Cancel</button>
          )}
        </div>
      </div>
    </div>
  )
}

interface TrackedProduct {
  id: string
  name: string
  page_url: string
  keywords: string[]
  market: string
  active: boolean
  notes?: string | null
  created_at: string
}

// ── Keyword tag input ─────────────────────────────────────────────────────────
function KeywordTagInput({ keywords, onChange }: { keywords: string[]; onChange: (kws: string[]) => void }) {
  const [input, setInput] = useState('')

  function add() {
    const kw = input.trim()
    if (kw && !keywords.includes(kw)) onChange([...keywords, kw])
    setInput('')
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
        {keywords.map(kw => (
          <span key={kw} className="inline-flex items-center gap-1 text-xs bg-gray-700 text-gray-200 px-2 py-1 rounded-full">
            {kw}
            <button onClick={() => onChange(keywords.filter(k => k !== kw))} className="text-gray-500 hover:text-red-400 leading-none">×</button>
          </span>
        ))}
        {keywords.length === 0 && <span className="text-xs text-gray-600">No keywords yet</span>}
      </div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Type keyword, press Enter…"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-red-500"
        />
        <button onClick={add} className="text-xs px-2 py-1.5 bg-gray-700 hover:bg-gray-600 text-white rounded transition">+ Add</button>
      </div>
    </div>
  )
}

// ── Add / Edit Form ───────────────────────────────────────────────────────────
function ProductForm({ initial, onSave, onCancel }: {
  initial?: Partial<TrackedProduct>
  onSave: (p: Omit<TrackedProduct, 'id' | 'created_at'>) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName]       = useState(initial?.name ?? '')
  const [url, setUrl]         = useState(initial?.page_url ?? '')
  const [keywords, setKws]    = useState<string[]>(initial?.keywords ?? [])
  const [market, setMarket]   = useState(initial?.market ?? 'us')
  const [notes, setNotes]     = useState(initial?.notes ?? '')
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !url.trim()) { setErr('Name and URL are required.'); return }
    setSaving(true); setErr(null)
    try {
      await onSave({ name, page_url: url, keywords, market, active: initial?.active ?? true, notes: notes || null })
    } catch (e) { setErr(String(e)) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800 border border-gray-700 rounded-xl p-5 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Product name <span className="text-red-500">*</span></label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. LoL Accounts"
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Market</label>
          <select value={market} onChange={e => setMarket(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
            {SERP_COUNTRIES.map(c => (
              <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">G2G page URL <span className="text-red-500">*</span></label>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.g2g.com/categories/..."
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1.5">Target keywords <span className="text-gray-600 font-normal">(for position tracking)</span></label>
        <KeywordTagInput keywords={keywords} onChange={setKws} />
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">Notes <span className="text-gray-600 font-normal">(optional)</span></label>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Priority Q1, check weekly"
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500" />
      </div>

      {err && <p className="text-red-400 text-xs">{err}</p>}

      <div className="flex items-center gap-3 pt-1">
        <button type="submit" disabled={saving}
          className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-5 py-2 rounded-lg transition">
          {saving ? 'Saving…' : initial?.id ? 'Save changes' : 'Add product'}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-gray-500 hover:text-gray-300 transition">Cancel</button>
      </div>
    </form>
  )
}

// ── Product Card ──────────────────────────────────────────────────────────────
function ProductCard({ product, onDelete, onEdit }: {
  product: TrackedProduct
  onDelete: (id: string) => void
  onEdit: (p: TrackedProduct) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const country = SERP_COUNTRIES.find(c => c.code === product.market)

  async function handleDelete() {
    if (!confirm(`Delete "${product.name}"?`)) return
    setDeleting(true)
    await fetch(`/api/products?id=${product.id}`, { method: 'DELETE' })
    onDelete(product.id)
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-white font-semibold text-sm">{product.name}</h3>
            {country && (
              <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">{country.flag} {country.label}</span>
            )}
            {!product.active && (
              <span className="text-xs text-gray-600 bg-gray-800 px-2 py-0.5 rounded-full">Paused</span>
            )}
          </div>
          <a href={product.page_url} target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300 truncate block mt-0.5 transition">
            {product.page_url}
          </a>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => onEdit(product)} className="text-xs text-gray-500 hover:text-white px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 transition">
            Edit
          </button>
          <button onClick={handleDelete} disabled={deleting} className="text-xs text-gray-600 hover:text-red-400 px-2 py-1 rounded bg-gray-800 hover:bg-red-500/10 transition">
            {deleting ? '…' : 'Delete'}
          </button>
        </div>
      </div>

      {product.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {product.keywords.map(kw => (
            <span key={kw} className="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-full">{kw}</span>
          ))}
        </div>
      )}

      {product.notes && (
        <p className="text-xs text-gray-500 mt-2">{product.notes}</p>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ProductRankingsPage() {
  const [products, setProducts] = useState<TrackedProduct[]>([])
  const [loading, setLoading]   = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingProduct, setEditingProduct] = useState<TrackedProduct | null>(null)
  const [showImport, setShowImport] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/products')
      if (res.ok) {
        const { products } = await res.json()
        setProducts(products)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleSave(data: Omit<TrackedProduct, 'id' | 'created_at'>) {
    if (editingProduct) {
      const res = await fetch(`/api/products?id=${editingProduct.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to update')
    } else {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) throw new Error('Failed to create')
    }
    setShowForm(false)
    setEditingProduct(null)
    await load()
  }

  const activeProducts  = products.filter(p => p.active)
  const pausedProducts  = products.filter(p => !p.active)

  return (
    <div className="p-8 max-w-4xl">
      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={load}
        />
      )}

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🎯 Top Product Tracker</h1>
          <p className="text-gray-400 text-sm mt-1">
            Track daily keyword positions for your top G2G product pages.
            {products.length > 0 && ` ${activeProducts.length} active · ${products.length} total`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowImport(true)}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white text-sm font-medium px-4 py-2 rounded-xl transition flex items-center gap-2 border border-gray-700"
          >
            📥 Import CSV
          </button>
          <button
            onClick={() => { setEditingProduct(null); setShowForm(true) }}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition flex items-center gap-2"
          >
            + Add product
          </button>
        </div>
      </div>

      {/* Add / Edit form */}
      {(showForm || editingProduct) && (
        <div className="mb-6">
          <ProductForm
            initial={editingProduct ?? undefined}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditingProduct(null) }}
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex justify-center py-12">
          <LottieLoader size={80} text="Loading products…" />
        </div>
      )}

      {/* Empty state */}
      {!loading && products.length === 0 && !showForm && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">🎯</p>
          <p className="text-white font-semibold mb-1">No products tracked yet</p>
          <p className="text-gray-400 text-sm mb-5">
            Add your top G2G product pages and the keywords you want to monitor daily.
            <br />Daily position checks will run automatically once DataForSEO is configured.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition"
          >
            + Add your first product
          </button>
        </div>
      )}

      {/* Active products */}
      {!loading && activeProducts.length > 0 && (
        <div className="space-y-3 mb-6">
          {activeProducts.map(p => (
            <ProductCard
              key={p.id}
              product={p}
              onDelete={id => setProducts(prev => prev.filter(x => x.id !== id))}
              onEdit={p => { setEditingProduct(p); setShowForm(false); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
            />
          ))}
        </div>
      )}

      {/* Paused products */}
      {!loading && pausedProducts.length > 0 && (
        <div className="mt-6">
          <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Paused</p>
          <div className="space-y-3 opacity-60">
            {pausedProducts.map(p => (
              <ProductCard
                key={p.id}
                product={p}
                onDelete={id => setProducts(prev => prev.filter(x => x.id !== id))}
                onEdit={p => { setEditingProduct(p); setShowForm(false) }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Info banner */}
      {!loading && products.length > 0 && (
        <div className="mt-6 bg-blue-500/5 border border-blue-500/20 rounded-xl p-4">
          <p className="text-blue-300 text-xs font-medium mb-1">📊 Daily position checks coming soon</p>
          <p className="text-gray-500 text-xs">
            Position data via DataForSEO SERP API will be pulled automatically each morning and displayed here.
            The tracked keywords above will be used to check rankings on Google {products[0] ? `(${SERP_COUNTRIES.find(c => c.code === products[0].market)?.label ?? 'US'})` : ''}.
          </p>
        </div>
      )}
    </div>
  )
}
