'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import { TIER_CATEGORY_PRESETS } from '@/lib/product-tiers'

/**
 * /priority-products — the "war room" page for Tier 1 + Tier 2 products.
 *
 * Per-product aggregation card showing GSC last-7d clicks/position, open
 * opportunities, brief status breakdown, outreach in flight, and backlinks
 * earned this month. Sorted: Tier 1 → Tier 2, then health worst → best.
 *
 * Health computed server-side from the same row data, so the page just
 * renders. No client-side number crunching beyond filter+search.
 */

const UNCATEGORIZED = 'Uncategorized'

interface ProductRow {
  id:               string
  tier:             1 | 2
  productName:      string
  category:         string | null
  relationId:       string | null
  url:              string | null
  notes:            string | null
  clicks7d:         number
  clicksPrev7d:     number
  position:         number | null
  oppsOpen:         number
  briefsDraft:      number
  briefsLive:       number
  outreachInFlight: number
  outreachReplies:  number
  backlinksMtd:     number
  health:           'healthy' | 'monitor' | 'attention' | 'critical'
}

interface Summary {
  total:           number
  t1:              number
  t2:              number
  healthy:         number
  monitor:         number
  attention:       number
  critical:        number
  briefsInFlight:  number
  outreach7d:      number
  backlinksMtd:    number
}

const EMPTY_SUMMARY: Summary = {
  total: 0, t1: 0, t2: 0, healthy: 0, monitor: 0, attention: 0, critical: 0,
  briefsInFlight: 0, outreach7d: 0, backlinksMtd: 0,
}

export default function PriorityProductsPage() {
  const siteSlug = useSiteSlug()

  const [rows,    setRows]    = useState<ProductRow[]>([])
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(true)

  const [filterTier,     setFilterTier]     = useState<'all' | '1' | '2'>('all')
  const [filterHealth,   setFilterHealth]   = useState<'all' | 'critical' | 'attention' | 'monitor' | 'healthy'>('all')
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [search,         setSearch]         = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch('/api/priority-products')
      .then(r => r.ok ? r.json() : { products: [], summary: EMPTY_SUMMARY })
      .then((data: { products: ProductRow[]; summary: Summary }) => {
        if (cancelled) return
        setRows(data.products ?? [])
        setSummary(data.summary ?? EMPTY_SUMMARY)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [siteSlug])

  const visible = useMemo(() => {
    const s = search.trim().toLowerCase()
    return rows.filter(r => {
      if (filterTier !== 'all'   && String(r.tier) !== filterTier)   return false
      if (filterHealth !== 'all' && r.health !== filterHealth)        return false
      if (filterCategory !== 'all') {
        const c = r.category?.trim() || UNCATEGORIZED
        if (c !== filterCategory) return false
      }
      if (!s) return true
      return [r.productName, r.category, r.relationId, r.url, r.notes]
        .filter(Boolean)
        .some(v => (v as string).toLowerCase().includes(s))
    })
  }, [rows, filterTier, filterHealth, filterCategory, search])

  // Unique categories present across ALL rows (not just filtered) so the
  // dropdown stays consistent as you slice.
  const categoryOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) set.add(r.category?.trim() || UNCATEGORIZED)
    return Array.from(set).sort()
  }, [rows])

  /** Group rows by CATEGORY first, then split each group into Tier 1 / Tier 2
   *  subsections. This matches Galih's mental model: each category has its
   *  own Top 10 (T1) + Next 25 (T2). The display becomes:
   *    Game Accounts
   *      Tier 1 (top 10)  → rows
   *      Tier 2 (next 25) → rows
   *    Game Coins
   *      ...
   */
  const categoryGroups = useMemo(() => {
    const groups: Record<string, { t1: ProductRow[]; t2: ProductRow[] }> = {}
    for (const r of visible) {
      const k = r.category?.trim() || UNCATEGORIZED
      groups[k] ??= { t1: [], t2: [] }
      if (r.tier === 1) groups[k].t1.push(r)
      else              groups[k].t2.push(r)
    }
    const presetOrder = new Map<string, number>(TIER_CATEGORY_PRESETS.map((p, i) => [p, i]))
    const keys = Object.keys(groups).sort((a, b) => {
      if (a === UNCATEGORIZED) return 1
      if (b === UNCATEGORIZED) return -1
      const ia = presetOrder.get(a) ?? Infinity
      const ib = presetOrder.get(b) ?? Infinity
      if (ia !== ib) return ia - ib
      return a.localeCompare(b)
    })
    return keys.map(k => ({ category: k, ...groups[k] }))
  }, [visible])

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white mb-1">🎯 Priority Products</h1>
          <p className="text-sm text-gray-400">
            War room for top-priority products on <strong className="text-white">{siteSlug.toUpperCase()}</strong>.
            Each category has its own <strong className="text-amber-300">Tier 1 (top 10)</strong> + <strong className="text-blue-300">Tier 2 (next 25)</strong>.
            Priority alerts, deeper Bragi prompts, and weekly action plans run on every tiered product.
          </p>
        </div>
        <Link
          href="/settings/product-tiers"
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700"
        >
          ⚙ Manage tier list →
        </Link>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard label="Need attention" value={summary.attention + summary.critical} sub={`${summary.critical} critical`} accent="#ef4444" />
        <KpiCard label="Briefs in flight"  value={summary.briefsInFlight}             sub="all tiers"                accent="#6366f1" />
        <KpiCard label="Outreach in flight" value={summary.outreach7d}                sub="contacted, awaiting reply" accent="#8b5cf6" />
        <KpiCard label="Backlinks MTD"      value={summary.backlinksMtd}              sub="active links earned"     accent="#10b981" />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <input
          type="text"
          placeholder="Search products by name / URL / notes…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
        />
        <select
          value={filterTier}
          onChange={e => setFilterTier(e.target.value as 'all' | '1' | '2')}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
        >
          <option value="all">All tiers</option>
          <option value="1">Tier 1 only</option>
          <option value="2">Tier 2 only</option>
        </select>
        <select
          value={filterHealth}
          onChange={e => setFilterHealth(e.target.value as typeof filterHealth)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
        >
          <option value="all">All health</option>
          <option value="critical">🔴 Critical only</option>
          <option value="attention">⚠ Needs attention</option>
          <option value="monitor">👀 Monitor</option>
          <option value="healthy">✓ Healthy</option>
        </select>
        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gray-600"
        >
          <option value="all">All categories</option>
          {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <p className="text-gray-300 mb-2">No tier products yet for {siteSlug.toUpperCase()}.</p>
          <p className="text-sm text-gray-500 mb-4">Add your top 10 + next 25 products to start tracking them here.</p>
          <Link
            href="/settings/product-tiers"
            className="inline-block px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm rounded-lg"
          >
            Set up tier list →
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {categoryGroups.map(g => (
            <CategorySection
              key={g.category}
              category={g.category}
              t1Rows={g.t1}
              t2Rows={g.t2}
            />
          ))}
          {visible.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-8">No products match these filters.</p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * One category section. Header shows the category name + T1/T2 coverage
 * counts. Then two subsections: Tier 1 (top 10) and Tier 2 (next 25).
 * Empty subsections collapse to a single "0 products" hint so Galih sees
 * which categories still need filling.
 */
function CategorySection({ category, t1Rows, t2Rows }: {
  category: string
  t1Rows:   ProductRow[]
  t2Rows:   ProductRow[]
}) {
  const T1_CAP = 10
  const T2_CAP = 25
  return (
    <section className="bg-gray-950/30 border border-gray-800 rounded-xl p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-bold text-white">{category}</h2>
        <div className="flex items-center gap-3 text-[11px]">
          <span className={t1Rows.length > T1_CAP ? 'text-red-400' : 'text-amber-300'}>
            T1: {t1Rows.length}/{T1_CAP}
          </span>
          <span className={t2Rows.length > T2_CAP ? 'text-red-400' : 'text-blue-300'}>
            T2: {t2Rows.length}/{T2_CAP}
          </span>
        </div>
      </div>

      <div className="space-y-4">
        <TierSubsection
          label="Tier 1 — Top 10"
          accent="#f59e0b"
          rows={t1Rows}
          emptyHint={`No Tier 1 products tagged in ${category} yet — add ${T1_CAP} top performers.`}
        />
        <TierSubsection
          label="Tier 2 — Next 25"
          accent="#3b82f6"
          rows={t2Rows}
          emptyHint={`No Tier 2 products tagged in ${category} yet.`}
        />
      </div>
    </section>
  )
}

function TierSubsection({ label, accent, rows, emptyHint }: {
  label:     string
  accent:    string
  rows:      ProductRow[]
  emptyHint: string
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <div className="w-1 h-3 rounded" style={{ backgroundColor: accent }} />
        <h3 className="text-[10px] font-bold uppercase tracking-wider" style={{ color: accent }}>{label}</h3>
        <span className="text-[10px] text-gray-500">· {rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-gray-600 italic px-1.5 py-2">{emptyHint}</p>
      ) : (
        <div className="space-y-2">
          {rows.map(r => <ProductCard key={r.id} row={r} />)}
        </div>
      )}
    </div>
  )
}

function ProductCard({ row }: { row: ProductRow }) {
  const wowPct = row.clicksPrev7d > 0
    ? Math.round(((row.clicks7d - row.clicksPrev7d) / row.clicksPrev7d) * 100)
    : null

  const healthCfg = HEALTH_CFG[row.health]

  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition">
      <div className="flex items-start gap-4">
        {/* Tier + health markers */}
        <div className="flex flex-col items-center gap-1.5 pt-1">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
            row.tier === 1 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                            : 'bg-blue-500/15  text-blue-300  border-blue-500/30'
          }`}>
            T{row.tier}
          </span>
          <span title={healthCfg.tooltip} className={`text-[10px] px-1.5 py-0.5 rounded border ${healthCfg.cls}`}>
            {healthCfg.icon}
          </span>
        </div>

        {/* Title + URL + GSC line */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-3">
            <p className="text-white font-semibold truncate">{row.productName}</p>
            {row.url && (
              <a href={row.url} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:text-blue-300 truncate">
                ↗ {new URL(row.url).pathname}
              </a>
            )}
          </div>

          <p className="text-xs text-gray-400 mt-1">
            <span className="text-gray-300 font-medium">{fmt(row.clicks7d)}</span> clicks (7d)
            {wowPct != null && (
              <span className={`ml-1.5 ${wowPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {wowPct >= 0 ? '+' : ''}{wowPct}%
              </span>
            )}
            {row.position != null && (
              <span className="ml-3 text-gray-500">· avg pos #{row.position.toFixed(1)}</span>
            )}
          </p>

          {row.notes && <p className="text-[11px] text-gray-500 italic mt-1 truncate">{row.notes}</p>}

          {/* Output stats row */}
          <div className="flex items-center gap-4 mt-2.5 text-xs flex-wrap">
            <Stat label="open opps"      value={row.oppsOpen}      tone={row.oppsOpen > 0 ? 'amber' : 'neutral'} />
            <Stat label="briefs draft"   value={row.briefsDraft}   tone={row.briefsDraft > 0 ? 'indigo' : 'neutral'} />
            <Stat label="briefs live"    value={row.briefsLive}    tone={row.briefsLive > 0 ? 'emerald' : 'neutral'} />
            <Stat label="outreach sent"  value={row.outreachInFlight} tone={row.outreachInFlight > 0 ? 'purple' : 'neutral'} />
            <Stat label="replies"        value={row.outreachReplies}  tone={row.outreachReplies > 0 ? 'emerald' : 'neutral'} />
            <Stat label="backlinks MTD"  value={row.backlinksMtd}  tone={row.backlinksMtd > 0 ? 'emerald' : 'neutral'} />
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-col gap-1.5 flex-shrink-0">
          <Link
            href={`/command-center/pipeline?q=${encodeURIComponent(row.productName)}`}
            className="text-[11px] px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-200 text-center"
          >
            View opps →
          </Link>
          <Link
            href={`/content/topics/${encodeURIComponent(row.productName.toLowerCase().replace(/\s+/g, '-'))}`}
            className="text-[11px] px-2.5 py-1 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-gray-200 text-center"
          >
            Topic detail →
          </Link>
        </div>
      </div>
    </div>
  )
}

function KpiCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 font-semibold">{label}</p>
      <p className="text-3xl font-bold text-white leading-tight">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'amber' | 'emerald' | 'indigo' | 'purple' }) {
  const cls =
    tone === 'amber'   ? 'text-amber-300' :
    tone === 'emerald' ? 'text-emerald-300' :
    tone === 'indigo'  ? 'text-indigo-300' :
    tone === 'purple'  ? 'text-purple-300' :
                          'text-gray-500'
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`font-semibold ${cls}`}>{value}</span>
      <span className="text-gray-500">{label}</span>
    </span>
  )
}

const HEALTH_CFG = {
  critical:  { icon: '🔴', cls: 'bg-red-500/10 text-red-300 border-red-500/30',         tooltip: 'Critical — clicks dropped >25% wow OR ≥3 open opportunities' },
  attention: { icon: '⚠',  cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30',   tooltip: 'Needs attention — clicks dropped 10-25% OR has open opportunities' },
  monitor:   { icon: '👀', cls: 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30', tooltip: 'Monitor — brief in flight, watching outcomes' },
  healthy:   { icon: '✓',  cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', tooltip: 'Healthy — stable / growing, no open issues' },
} as const

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
