'use client'

import { useEffect, useRef, useState } from 'react'

// ─── G2G catalog typeahead picker ────────────────────────────────────────────
// Drop-in autocomplete that searches the canonical g2g_products table and
// fires onPick with the full row when the user selects something. Used by:
//   • /settings/product-tiers — auto-fill product_name + category + relation_id
//   • Future: brief generator, opportunity → product linker, etc.
//
// Wire-up:
//   <CatalogPicker
//     placeholder="Search G2G catalog…"
//     onPick={row => {
//       setForm(f => ({
//         ...f,
//         product_name: row.brand_name,
//         category:     row.service_name,
//         relation_id:  row.relation_id,
//       }))
//     }}
//   />

export interface CatalogRow {
  relation_id:    string
  service_id:     string
  brand_id:       string
  service_name:   string
  brand_name:     string
  cms_created_at: string | null
  is_active:      boolean
}

interface Props {
  placeholder?:    string
  onPick:          (row: CatalogRow) => void
  /** Filter results to a specific service_name (e.g. only "Accounts"). */
  service?:        string
  /** Include inactive products in results (default: false). */
  includeInactive?: boolean
  /** Auto-clear input after pick (default: true). */
  clearOnPick?:    boolean
  className?:      string
}

export default function CatalogPicker({
  placeholder = 'Search G2G catalog by brand or category…',
  onPick,
  service,
  includeInactive = false,
  clearOnPick = true,
  className = '',
}: Props) {
  const [q,       setQ]       = useState('')
  const [results, setResults] = useState<CatalogRow[]>([])
  const [open,    setOpen]    = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const debouncer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Debounced fetch. Defer all state changes into the timeout callback so we
  // don't trigger the react-hooks/set-state-in-effect lint (cascading renders).
  useEffect(() => {
    if (debouncer.current) clearTimeout(debouncer.current)
    const tooShort = q.trim().length < 2
    debouncer.current = setTimeout(async () => {
      if (tooShort) {
        setResults([])
        return
      }
      setLoading(true)
      try {
        const params = new URLSearchParams({ q, limit: '15' })
        if (service)         params.set('service', service)
        if (includeInactive) params.set('include_inactive', '1')
        const res = await fetch(`/api/g2g-catalog/search?${params}`)
        const data = await res.json() as { results?: CatalogRow[] }
        setResults(data.results ?? [])
        setActiveIdx(0)
      } catch {
        setResults([])
      }
      setLoading(false)
    }, tooShort ? 0 : 200)
    return () => { if (debouncer.current) clearTimeout(debouncer.current) }
  }, [q, service, includeInactive])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  function pick(row: CatalogRow) {
    onPick(row)
    if (clearOnPick) setQ('')
    setOpen(false)
    setResults([])
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(results[activeIdx])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <input
        type="text"
        value={q}
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />
      {open && (q.trim().length >= 2 || results.length > 0) && (
        <div className="absolute left-0 right-0 top-full mt-1 z-40 max-h-80 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          {loading && (
            <div className="px-3 py-2 text-xs text-gray-500">Searching catalog…</div>
          )}
          {!loading && results.length === 0 && q.trim().length >= 2 && (
            <div className="px-3 py-2 text-xs text-gray-500">No products match. Try fewer words or a brand keyword.</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.relation_id}
              type="button"
              onClick={() => pick(r)}
              onMouseEnter={() => setActiveIdx(i)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-gray-800/50 last:border-0 transition ${
                i === activeIdx ? 'bg-blue-500/15 text-white' : 'text-gray-200 hover:bg-gray-800'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium truncate">{r.brand_name}</span>
                <span className="text-xs text-gray-400 shrink-0">{r.service_name}</span>
              </div>
              <div className="text-[10px] text-gray-500 font-mono mt-0.5">
                {r.brand_id} · {r.relation_id.slice(0, 8)}…
                {!r.is_active && <span className="ml-2 text-amber-400">inactive</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
