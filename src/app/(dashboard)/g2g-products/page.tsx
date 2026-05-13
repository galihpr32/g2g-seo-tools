'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

// ─── Standalone Product Browser ─────────────────────────────────────────────
// Reads the canonical G2G catalog and decorates each row with workspace state
// (in tier? content generated? uploaded to CMS?). Lets the team explore the
// 13k products and jump straight into the right tool (add to tier, see brief,
// view rankings) instead of bouncing through Settings.
//
// This page is workspace-wide (not just admin) — anyone with workspace access
// can browse. Mutations stay behind their respective admin pages.

interface CatalogRow {
  relation_id:    string
  service_id:     string
  brand_id:       string
  service_name:   string
  brand_name:     string
  cms_created_at: string | null
  is_active:      boolean
}

interface Stats {
  total_products:    number
  active_products:   number
  by_service_name:   { service_name: string; count: number }[]
}

// Workspace overlay flags drawn from product_content_queue / product_tiers
interface Overlay {
  tieredSet:   Set<string>
  contentSet:  Set<string>
  uploadedSet: Set<string>
}

export default function ProductBrowserPage() {
  const [stats,   setStats]   = useState<Stats | null>(null)
  const [rows,    setRows]    = useState<CatalogRow[]>([])
  const [overlay, setOverlay] = useState<Overlay>({ tieredSet: new Set(), contentSet: new Set(), uploadedSet: new Set() })

  const [q,       setQ]       = useState('')
  const [service, setService] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'no_content' | 'no_tier' | 'no_upload'>('all')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/g2g-catalog/stats')
        if (res.ok) setStats(await res.json())
      } catch { /* silent */ }
    })()
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const params = new URLSearchParams({ limit: '100' })
        if (q)       params.set('q', q)
        if (service) params.set('service', service)
        const res  = await fetch(`/api/g2g-catalog/search?${params}`)
        const data = await res.json() as { results?: CatalogRow[] }
        const list = data.results ?? []
        if (cancelled) return
        setRows(list)
        if (list.length) {
          const ovrRes = await fetch('/api/g2g-catalog/decorate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ relation_ids: list.map(r => r.relation_id) }),
          })
          if (ovrRes.ok && !cancelled) {
            const ovr = await ovrRes.json() as { tiered?: string[]; content?: string[]; uploaded?: string[] }
            setOverlay({
              tieredSet:   new Set(ovr.tiered   ?? []),
              contentSet:  new Set(ovr.content  ?? []),
              uploadedSet: new Set(ovr.uploaded ?? []),
            })
          }
        }
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [q, service])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return rows
    return rows.filter(r => {
      if (statusFilter === 'no_content') return !overlay.contentSet.has(r.relation_id)
      if (statusFilter === 'no_tier')    return !overlay.tieredSet.has(r.relation_id)
      if (statusFilter === 'no_upload')  return !overlay.uploadedSet.has(r.relation_id)
      return true
    })
  }, [rows, overlay, statusFilter])

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🗂 G2G Products</h1>
          <p className="text-sm text-gray-400 mt-1">
            Explore the canonical CMS catalog. Decorated with workspace state — see which products already have AI content, are in a tier, or have been uploaded.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/settings/g2g-products" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700">
            ⚙ Catalog admin
          </Link>
          <Link href="/priority-products" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700">
            🎯 Priority Products
          </Link>
        </div>
      </div>

      {/* KPIs */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Kpi label="Active products"      value={stats.active_products.toLocaleString()} />
          <Kpi label="AI content generated" value={overlay.contentSet.size.toLocaleString()  + ' shown'} />
          <Kpi label="CMS-uploaded"         value={overlay.uploadedSet.size.toLocaleString() + ' shown'} />
          <Kpi label="In a tier"            value={overlay.tieredSet.size.toLocaleString()   + ' shown'} />
        </div>
      )}

      {/* Filter bar */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-3 flex flex-wrap gap-2 items-center text-sm">
        <input
          type="text"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search brand or brand_id…"
          className="bg-gray-950 border border-gray-700 rounded-md px-3 py-1.5 text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 flex-1 min-w-[200px]"
        />
        <select
          value={service}
          onChange={e => setService(e.target.value)}
          className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
        >
          <option value="">All categories</option>
          {(stats?.by_service_name ?? []).map(c => (
            <option key={c.service_name} value={c.service_name}>{c.service_name} ({c.count.toLocaleString()})</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
          className="bg-gray-950 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
        >
          <option value="all">All products</option>
          <option value="no_content">Missing AI content</option>
          <option value="no_tier">Not in a tier</option>
          <option value="no_upload">Not uploaded to CMS</option>
        </select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left px-3 py-2">Brand</th>
                <th className="text-left px-3 py-2">Category</th>
                <th className="text-left px-3 py-2">Workspace state</th>
                <th className="text-left px-3 py-2">IDs</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">Loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">No products match these filters.</td></tr>
              )}
              {!loading && filtered.map(r => (
                <tr key={r.relation_id} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                  <td className="px-3 py-2 text-white">{r.brand_name}</td>
                  <td className="px-3 py-2 text-gray-300">{r.service_name}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      <StateBadge label="Content" active={overlay.contentSet.has(r.relation_id)}  tone="blue"   />
                      <StateBadge label="CMS"     active={overlay.uploadedSet.has(r.relation_id)} tone="green"  />
                      <StateBadge label="Tier"    active={overlay.tieredSet.has(r.relation_id)}   tone="amber"  />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 font-mono">
                    <div>{r.brand_id}</div>
                    <div className="text-gray-600">{r.relation_id.slice(0, 8)}…</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/settings/product-tiers?prefill=${encodeURIComponent(r.relation_id)}`}
                      className="text-xs text-blue-300 hover:text-blue-200"
                    >Add to tier →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 100 && (
          <p className="px-3 py-2 text-xs text-gray-500 border-t border-gray-800">Showing first 100 — narrow search to see more.</p>
        )}
      </div>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-bold text-white mt-0.5">{value}</p>
    </div>
  )
}

function StateBadge({ label, active, tone }: { label: string; active: boolean; tone: 'blue' | 'green' | 'amber' }) {
  if (!active) return <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border border-gray-800 text-gray-600">○ {label}</span>
  const colors = {
    blue:  'border-blue-700  bg-blue-500/15  text-blue-300',
    green: 'border-green-700 bg-green-500/15 text-green-300',
    amber: 'border-amber-700 bg-amber-500/15 text-amber-300',
  }[tone]
  return (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border ${colors}`}>
      ● {label}
    </span>
  )
}
