'use client'

import { useEffect, useState } from 'react'

// ─── Bulk-add Priority Products from the canonical G2G catalog ──────────────
// Workflow:
//   1. Pick a service category (Accounts, Top Up, Gift Cards, …)
//   2. Optionally filter by brand keyword
//   3. Check the products you want added to Tier 1 or Tier 2
//   4. Submit — server upserts everything in one call via
//      POST /api/product-tiers/bulk-from-catalog

interface CatalogRow {
  relation_id:  string
  service_id:   string
  brand_id:     string
  service_name: string
  brand_name:   string
  is_active:    boolean
}

interface Stats {
  by_service_name: { service_name: string; count: number }[]
}

interface Result {
  inserted: number
  updated:  number
  skipped:  { relation_id: string; reason: string }[]
}

interface Props {
  open:      boolean
  onClose:   () => void
  /** Caller refreshes its tier list after a successful bulk insert. */
  onApplied: () => void
}

export default function BulkFromCatalogModal({ open, onClose, onApplied }: Props) {
  const [stats,   setStats]   = useState<Stats | null>(null)
  const [service, setService] = useState('')
  const [q,       setQ]       = useState('')
  const [tier,    setTier]    = useState<1 | 2>(1)
  const [rows,    setRows]    = useState<CatalogRow[]>([])
  const [picked,  setPicked]  = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result,  setResult]  = useState<Result | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void (async () => {
      const res = await fetch('/api/g2g-catalog/stats')
      if (res.ok) setStats(await res.json())
    })()
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!service) { setRows([]); return }
    // Inline the search so we don't have to declare a fn-recreated-per-render.
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams({ service, limit: '100' })
        if (q.trim()) params.set('q', q.trim())
        const res = await fetch(`/api/g2g-catalog/search?${params}`)
        const data = await res.json() as { results?: CatalogRow[] }
        if (!cancelled) setRows(data.results ?? [])
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, service, q])

  function togglePick(id: string) {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function pickAll() {
    setPicked(new Set(rows.map(r => r.relation_id)))
  }

  function clearAll() {
    setPicked(new Set())
  }

  async function submit() {
    if (picked.size === 0) { setError('Pick at least one product first.'); return }
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/product-tiers/bulk-from-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, relation_ids: Array.from(picked) }),
      })
      const data = await res.json() as Result & { error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Bulk insert failed')
      } else {
        setResult(data)
        setPicked(new Set())
        onApplied()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setSubmitting(false)
  }

  function close() {
    setService(''); setQ(''); setRows([]); setPicked(new Set()); setResult(null); setError(null)
    onClose()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-white font-semibold">📚 Bulk-add from G2G Catalog</h2>
            <p className="text-xs text-gray-400 mt-0.5">Auto-fills product name, category, and Relation ID from the canonical CMS catalog.</p>
          </div>
          <button onClick={close} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-3 overflow-y-auto">
          {/* Step 1: pick category */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">1. Pick a category</label>
            <div className="flex flex-wrap gap-1.5">
              {(stats?.by_service_name ?? []).map(c => (
                <button
                  key={c.service_name}
                  onClick={() => { setService(c.service_name); setPicked(new Set()) }}
                  className={`px-3 py-1.5 text-xs rounded-full border transition ${
                    service === c.service_name
                      ? 'border-blue-500 bg-blue-500/20 text-white'
                      : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-500'
                  }`}
                >
                  {c.service_name} <span className="text-gray-500">({c.count.toLocaleString()})</span>
                </button>
              ))}
            </div>
          </div>

          {service && (
            <>
              {/* Step 2: filter + tier choice */}
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="Filter by brand or brand_id…"
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px]"
                />
                <div className="flex items-center gap-1 text-sm">
                  <span className="text-gray-400">Add as:</span>
                  {[1, 2].map(t => (
                    <button
                      key={t}
                      onClick={() => setTier(t as 1 | 2)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition ${
                        tier === t
                          ? (t === 1 ? 'bg-amber-600 border-amber-500 text-white' : 'bg-blue-600 border-blue-500 text-white')
                          : 'border-gray-700 bg-gray-950 text-gray-300 hover:border-gray-500'
                      }`}
                    >
                      Tier {t}
                    </button>
                  ))}
                </div>
              </div>

              {/* Step 3: pick rows */}
              <div className="rounded-lg border border-gray-800 bg-gray-950">
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800 text-xs">
                  <span className="text-gray-400">
                    {loading ? 'Loading…' : `${rows.length} products${rows.length === 100 ? ' (showing first 100 — narrow filter to see more)' : ''}`}
                  </span>
                  <div className="flex gap-2">
                    <button onClick={pickAll}  className="text-blue-300 hover:text-blue-200">Select all</button>
                    <span className="text-gray-600">·</span>
                    <button onClick={clearAll} className="text-gray-400 hover:text-gray-200">Clear</button>
                  </div>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {!loading && rows.length === 0 && (
                    <p className="px-3 py-6 text-sm text-gray-500 text-center">No products match.</p>
                  )}
                  {rows.map(r => {
                    const isPicked = picked.has(r.relation_id)
                    return (
                      <label key={r.relation_id} className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer border-b border-gray-800/50 last:border-0 transition ${
                        isPicked ? 'bg-blue-500/10' : 'hover:bg-gray-800/40'
                      }`}>
                        <input
                          type="checkbox"
                          checked={isPicked}
                          onChange={() => togglePick(r.relation_id)}
                        />
                        <span className="text-white flex-1 truncate">{r.brand_name}</span>
                        <span className="text-xs text-gray-500 font-mono shrink-0">{r.brand_id}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {error  && <p className="text-sm text-red-400">❌ {error}</p>}
          {result && (
            <div className="rounded-md border border-green-700/50 bg-green-500/5 p-3 text-sm text-green-200">
              ✅ Done — inserted <b>{result.inserted}</b>, updated <b>{result.updated}</b>
              {result.skipped.length > 0 && (
                <>, skipped <b>{result.skipped.length}</b>
                  <details className="mt-1">
                    <summary className="text-amber-300 cursor-pointer text-xs">Why skipped?</summary>
                    <ul className="mt-1 text-xs text-amber-200 list-disc pl-5">
                      {result.skipped.slice(0, 20).map(s => (
                        <li key={s.relation_id}>{s.relation_id.slice(0, 8)}…: {s.reason}</li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-between shrink-0">
          <span className="text-xs text-gray-400">
            {picked.size > 0 && <>📌 <b className="text-white">{picked.size}</b> selected · adding to <b className={tier === 1 ? 'text-amber-300' : 'text-blue-300'}>Tier {tier}</b></>}
          </span>
          <div className="flex gap-2">
            <button onClick={close} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white text-sm rounded-lg">Close</button>
            <button
              onClick={submit}
              disabled={submitting || picked.size === 0}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg"
            >
              {submitting ? 'Saving…' : `Add ${picked.size} to Tier ${tier}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
