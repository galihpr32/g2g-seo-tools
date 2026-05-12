'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import { TIER_MARKETS, TIER_MARKET_CODES, type TierMarket } from '@/lib/ranking-tracker'

/**
 * /priority-products/rankings — Aggregate Keyword Rankings Dashboard
 *
 * Single-pane view of where every Tier 1 + Tier 2 keyword ranks across the 5
 * tracked markets, with filtering, distribution chart, top movers, per-product
 * summary, and a competitor outranking aggregate.
 *
 * Layout sections (top → bottom):
 *   1. Filter bar — tier, market, category, time range
 *   2. KPI strip (5 cards)
 *   3. Rankings Distribution stacked-bar chart
 *   4. Top Movers — gainers vs losers (2 columns)
 *   5. Per-Product Summary table
 *   6. Outranking Competitors table
 */

interface Kpis {
  kwTracked:        number
  avgPosition:      number | null
  avgPositionDelta: number | null
  top3:             number
  top3Delta:        number
  top10:            number
  top10Delta:       number
  top20:            number
  notRanking:       number
  notRankingDelta:  number
}

interface DistributionPoint {
  date:    string
  top3:    number
  top10:   number
  top20:   number
  top50:   number
  outside: number
}

interface Mover {
  productName: string
  keyword:     string
  market:      string
  prevPos:     number | null
  currPos:     number | null
  delta:       number
}

interface ProductSummary {
  id:           string
  productName:  string
  tier:         1 | 2
  category:     string | null
  url:          string | null
  kwCount:      number
  avgPosition:  number | null
  top3:         number
  top10:        number
  wowDelta:     number | null
}

interface CompetitorRow {
  domain:        string
  kwOutranking:  number
  avgPos:        number
}

interface ApiBundle {
  filters: { tier: string; market: string; category: string; range: string }
  kpis:    Kpis
  distribution: DistributionPoint[]
  topMovers:   { gainers: Mover[]; losers: Mover[] }
  products:    ProductSummary[]
  competitors: CompetitorRow[]
  categories:  string[]
  markets:     readonly string[]
}

// Shape returned by /api/priority-products/[id] — used to populate the
// expanded leaderboard row inline.
interface ProductDetailBundle {
  leaderboard: Array<{
    keyword:   string
    is_main:   boolean
    positions: Record<string, { position: number | null; url: string | null; snapshot_date: string | null }>
  }>
  markets: string[]
}

const RANGE_LABELS: Record<string, string> = {
  '1d':  '1 day',
  '1w':  '1 week',
  '4w':  '4 weeks',
  '8w':  '8 weeks',
  '12w': '12 weeks',
}

export default function RankingsDashboardPage() {
  const siteSlug = useSiteSlug()

  const [data,    setData]    = useState<ApiBundle | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Filter state
  const [tier,     setTier]     = useState<'all' | '1' | '2'>('all')
  const [market,   setMarket]   = useState<string>('all')
  const [category, setCategory] = useState<string>('all')
  const [range,    setRange]    = useState<string>('1w')
  const [search,   setSearch]   = useState('')

  // Expanded row state — which products show their keyword × market leaderboard
  // inline. Lazy-loaded from /api/priority-products/[id] on first expand.
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set())
  const [detailCache, setDetailCache] = useState<Record<string, ProductDetailBundle>>({})
  const [detailLoading, setDetailLoading] = useState<Set<string>>(new Set())

  async function toggleExpand(productId: string) {
    const next = new Set(expanded)
    if (next.has(productId)) {
      next.delete(productId)
      setExpanded(next)
      return
    }
    next.add(productId)
    setExpanded(next)

    if (detailCache[productId]) return  // already loaded

    setDetailLoading(prev => new Set(prev).add(productId))
    try {
      const res = await fetch(`/api/priority-products/${productId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body: ProductDetailBundle = await res.json()
      setDetailCache(prev => ({ ...prev, [productId]: body }))
    } catch (e) {
      console.error('Failed to load detail for', productId, e)
    } finally {
      setDetailLoading(prev => { const n = new Set(prev); n.delete(productId); return n })
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ tier, market, category, range })
    fetch(`/api/priority-products/rankings?${params.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body: ApiBundle) => { if (!cancelled) setData(body) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tier, market, category, range, siteSlug])

  const filteredProducts = useMemo(() => {
    if (!data) return []
    const s = search.trim().toLowerCase()
    if (!s) return data.products
    return data.products.filter(p =>
      p.productName.toLowerCase().includes(s) || (p.category ?? '').toLowerCase().includes(s),
    )
  }, [data, search])

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link href="/priority-products" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
            ← Priority Products
          </Link>
          <h1 className="text-2xl font-bold text-white mb-1">📊 Rankings Dashboard</h1>
          <p className="text-sm text-gray-400">
            Aggregate SERP positions across all Tier 1 + Tier 2 products on <strong className="text-white">{siteSlug.toUpperCase()}</strong>.
            Data refreshed weekly from DataForSEO across {TIER_MARKET_CODES.length} markets.
          </p>
        </div>
        <Link
          href="/priority-products"
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700"
        >
          📦 Product cards →
        </Link>
      </div>

      {/* Filter bar */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-3 mb-6 flex items-center gap-3 flex-wrap text-xs sticky top-0 z-20 backdrop-blur">
        <span className="text-gray-500">Filter:</span>
        <select value={tier} onChange={e => setTier(e.target.value as 'all' | '1' | '2')} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white">
          <option value="all">All tiers</option>
          <option value="1">Tier 1 only</option>
          <option value="2">Tier 2 only</option>
        </select>
        <select value={market} onChange={e => setMarket(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white">
          <option value="all">All markets</option>
          {TIER_MARKET_CODES.map(m => <option key={m} value={m}>{TIER_MARKETS[m as TierMarket].label}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white">
          <option value="all">All categories</option>
          {(data?.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <span className="text-gray-700 mx-1">·</span>
        <span className="text-gray-500">Range:</span>
        <select value={range} onChange={e => setRange(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white">
          {Object.entries(RANGE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>

        <input
          type="text"
          placeholder="Search product/category…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white placeholder-gray-600 min-w-[200px]"
        />
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800/40 rounded-lg p-4 mb-6 text-sm text-red-200">
          Failed to load: {error}
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading rankings data…</p>
      ) : !data ? null : (
        <>
          {/* KPI Strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
            <KpiCard label="Keywords tracked" value={data.kpis.kwTracked.toString()} accent="#6366f1" />
            <KpiCard
              label="Avg position"
              value={data.kpis.avgPosition != null ? `#${data.kpis.avgPosition.toFixed(1)}` : '—'}
              delta={data.kpis.avgPositionDelta}
              deltaLabel={`vs ${RANGE_LABELS[range]} ago`}
              accent="#f59e0b"
              positiveIsGood
            />
            <KpiCard
              label="Top 3"
              value={data.kpis.top3.toString()}
              delta={data.kpis.top3Delta}
              deltaLabel="WoW"
              accent="#10b981"
              positiveIsGood
            />
            <KpiCard
              label="Top 10"
              value={data.kpis.top10.toString()}
              delta={data.kpis.top10Delta}
              deltaLabel="WoW"
              accent="#3b82f6"
              positiveIsGood
            />
            <KpiCard
              label="Not ranking"
              value={data.kpis.notRanking.toString()}
              delta={data.kpis.notRankingDelta}
              deltaLabel="WoW"
              accent="#ef4444"
              positiveIsGood={false}   // negative is good (fewer outside top 50)
            />
          </div>

          {/* Rankings Distribution Chart */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold text-white">Rankings Distribution</h2>
                <p className="text-[10px] text-gray-500 mt-0.5">Keyword count per position bucket over time (weekly SERP snapshots)</p>
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <LegendDot color="#10b981" label="Top 3" />
                <LegendDot color="#3b82f6" label="4-10" />
                <LegendDot color="#f59e0b" label="11-20" />
                <LegendDot color="#fb923c" label="21-50" />
                <LegendDot color="#6b7280" label="Outside" />
              </div>
            </div>
            <DistributionChart data={data.distribution} />
          </section>

          {/* Top Movers — gainers + losers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <MoversCard title="📈 Gainers" rows={data.topMovers.gainers} positive />
            <MoversCard title="📉 Losers"  rows={data.topMovers.losers}  positive={false} />
          </div>

          {/* Per-Product Summary Table */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white">Per-Product Summary</h2>
                <p className="text-[10px] text-gray-500 mt-0.5">{filteredProducts.length} product{filteredProducts.length !== 1 ? 's' : ''} matching filters · click row to open detail</p>
              </div>
            </div>
            {filteredProducts.length === 0 ? (
              <p className="p-6 text-sm text-gray-500">No products match these filters.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left  px-3 py-2">Product</th>
                    <th className="text-left  px-3 py-2 w-16">Tier</th>
                    <th className="text-left  px-3 py-2 hidden md:table-cell">Category</th>
                    <th className="text-right px-3 py-2">KWs</th>
                    <th className="text-right px-3 py-2">Avg Pos</th>
                    <th className="text-right px-3 py-2 hidden md:table-cell">Top 3</th>
                    <th className="text-right px-3 py-2 hidden md:table-cell">Top 10</th>
                    <th className="text-right px-3 py-2 w-24">WoW Δ</th>
                    <th className="text-right px-3 py-2 w-24">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProducts.map(p => {
                    const isOpen = expanded.has(p.id)
                    const detail = detailCache[p.id]
                    const isLoading = detailLoading.has(p.id)
                    return (
                      <Fragment key={p.id}>
                        <tr
                          className="border-t border-gray-800 hover:bg-gray-800/30 cursor-pointer"
                          onClick={() => toggleExpand(p.id)}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-gray-500 text-xs transition-transform inline-block ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                              <div className="min-w-0">
                                <p className="text-white font-medium truncate">{p.productName}</p>
                                {p.url && <p className="text-[10px] text-gray-500 truncate">{p.url}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                              p.tier === 1 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                            }`}>T{p.tier}</span>
                          </td>
                          <td className="px-3 py-2.5 text-gray-400 hidden md:table-cell text-xs">{p.category ?? '—'}</td>
                          <td className="px-3 py-2.5 text-right text-gray-200">{p.kwCount}</td>
                          <td className="px-3 py-2.5 text-right">
                            <PositionCell position={p.avgPosition} />
                          </td>
                          <td className="px-3 py-2.5 text-right text-gray-200 hidden md:table-cell">{p.top3}</td>
                          <td className="px-3 py-2.5 text-right text-gray-200 hidden md:table-cell">{p.top10}</td>
                          <td className="px-3 py-2.5 text-right">
                            <DeltaPill delta={p.wowDelta} />
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Link
                              href={`/priority-products/${p.id}`}
                              onClick={e => e.stopPropagation()}
                              className="text-xs text-blue-400 hover:text-blue-300"
                            >Detail →</Link>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-gray-950/40 border-t border-gray-800/50">
                            <td colSpan={9} className="px-4 py-3">
                              {isLoading ? (
                                <p className="text-xs text-gray-500 italic">Loading keyword breakdown…</p>
                              ) : !detail || detail.leaderboard.length === 0 ? (
                                <p className="text-xs text-gray-500 italic">
                                  No keyword data yet. <Link href={`/priority-products/${p.id}`} className="text-blue-400 hover:text-blue-300">Open detail page</Link> to add keywords.
                                </p>
                              ) : (
                                <KeywordLeaderboard rows={detail.leaderboard} markets={detail.markets} />
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* Outranking Competitors */}
          <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-white">🥷 Top Outranking Competitors</h2>
              <p className="text-[10px] text-gray-500 mt-0.5">Domains appearing ABOVE our position in tier keyword SERPs (across all markets in current filter). Outreach targets.</p>
            </div>
            {data.competitors.length === 0 ? (
              <p className="p-6 text-sm text-gray-500">No competitor data yet — run weekly SERP cron to populate.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
                  <tr>
                    <th className="text-left  px-3 py-2">Domain</th>
                    <th className="text-right px-3 py-2 w-40"># Tier KWs Outranking Us</th>
                    <th className="text-right px-3 py-2 w-32">Avg Pos (theirs)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.competitors.map(c => (
                    <tr key={c.domain} className="border-t border-gray-800 hover:bg-gray-800/30">
                      <td className="px-3 py-2.5 text-white">{c.domain}</td>
                      <td className="px-3 py-2.5 text-right text-amber-300 font-semibold">{c.kwOutranking}</td>
                      <td className="px-3 py-2.5 text-right text-gray-300">#{c.avgPos.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function KpiCard({ label, value, delta, deltaLabel, accent, positiveIsGood = true }: {
  label:           string
  value:           string
  delta?:          number | null
  deltaLabel?:     string
  accent:          string
  positiveIsGood?: boolean
}) {
  const deltaColor =
    delta == null || delta === 0
      ? 'text-gray-500'
      : (delta > 0) === positiveIsGood
        ? 'text-emerald-400'
        : 'text-red-400'
  const deltaSign = delta != null && delta > 0 ? '+' : ''

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: accent }} />
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1.5 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-white leading-tight">{value}</p>
      {delta != null && (
        <p className={`text-xs mt-1 ${deltaColor}`}>
          {deltaSign}{delta}{deltaLabel ? ` ${deltaLabel}` : ''}
        </p>
      )}
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-gray-400">{label}</span>
    </span>
  )
}

function DistributionChart({ data }: { data: DistributionPoint[] }) {
  if (data.length === 0) {
    return <p className="text-xs text-gray-500 py-12 text-center">No snapshots yet. Run /api/cron/tier-serp-weekly to populate.</p>
  }

  const w = 800, h = 220, padding = 32
  const max = Math.max(1, ...data.map(d => d.top3 + d.top10 + d.top20 + d.top50 + d.outside))
  const barW = (w - padding * 2) / data.length
  const yScale = (n: number) => (n / max) * (h - padding * 2)

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Bars stacked */}
      {data.map((d, i) => {
        const x = padding + i * barW
        const colW = Math.max(8, barW - 4)
        const buckets = [
          { v: d.top3,    color: '#10b981' },
          { v: d.top10,   color: '#3b82f6' },
          { v: d.top20,   color: '#f59e0b' },
          { v: d.top50,   color: '#fb923c' },
          { v: d.outside, color: '#6b7280' },
        ]
        let yOffset = h - padding
        return (
          <g key={d.date}>
            {buckets.map((b, j) => {
              const bh = yScale(b.v)
              const rect = (
                <rect key={j} x={x} y={yOffset - bh} width={colW} height={bh} fill={b.color}>
                  <title>{`${b.v} kws · ${d.date}`}</title>
                </rect>
              )
              yOffset -= bh
              return rect
            })}
            {/* X label */}
            <text x={x + colW / 2} y={h - padding + 12} fontSize="8" fill="#6b7280" textAnchor="middle">
              {d.date.slice(5)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function MoversCard({ title, rows, positive }: { title: string; rows: Mover[]; positive: boolean }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-white mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No movers yet — need at least 2 weekly snapshots to compare.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((m, i) => {
            const move = m.prevPos != null && m.currPos != null
              ? `#${m.prevPos} → #${m.currPos}`
              : m.currPos == null
                ? `#${m.prevPos ?? '?'} → out`
                : `entered → #${m.currPos}`
            return (
              <div key={i} className="flex items-start justify-between gap-2 text-xs bg-gray-800/40 rounded px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-white font-medium truncate">{m.keyword}</p>
                  <p className="text-[10px] text-gray-500">{m.productName} · {m.market.toUpperCase()}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-gray-200">{move}</p>
                  <p className={`text-[10px] font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
                    {positive ? '+' : ''}{m.delta}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PositionCell({ position }: { position: number | null }) {
  if (position == null) return <span className="text-gray-600 text-xs">—</span>
  const cls =
    position <= 3   ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
    position <= 10  ? 'bg-blue-500/15    text-blue-300    border-blue-500/30'    :
    position <= 20  ? 'bg-amber-500/15   text-amber-300   border-amber-500/30'   :
                       'bg-gray-700/40    text-gray-400    border-gray-600/30'
  return (
    <span className={`inline-flex items-center justify-center min-w-[36px] px-1.5 py-0.5 rounded border text-xs font-medium ${cls}`}>
      #{position.toFixed(1)}
    </span>
  )
}

/**
 * Inline keyword × market mini-leaderboard shown when a product row is
 * expanded in the dashboard. Compact version of the full leaderboard from
 * /priority-products/[id] — main keyword highlighted, all 5 markets in a row.
 */
function KeywordLeaderboard({ rows, markets }: {
  rows:    Array<{ keyword: string; is_main: boolean; positions: Record<string, { position: number | null; url: string | null; snapshot_date: string | null }> }>
  markets: string[]
}) {
  return (
    <div className="bg-gray-950/60 rounded border border-gray-800 overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-gray-800/30 text-gray-500 text-[9px] uppercase tracking-wider">
          <tr>
            <th className="text-left px-3 py-1.5">Keyword</th>
            {markets.map(m => (
              <th key={m} className="text-center px-2 py-1.5 w-14">{m.toUpperCase()}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.keyword} className="border-t border-gray-800/50">
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-1.5">
                  {r.is_main && <span className="text-amber-400 text-[9px]">★</span>}
                  <span className="text-gray-200">{r.keyword}</span>
                </div>
              </td>
              {markets.map(m => {
                const p = r.positions[m]?.position ?? null
                return (
                  <td key={m} className="text-center px-2 py-1.5">
                    <PositionCell position={p} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DeltaPill({ delta }: { delta: number | null }) {
  if (delta == null) return <span className="text-gray-600 text-xs">—</span>
  if (Math.abs(delta) < 0.05) return <span className="text-gray-500 text-xs">flat</span>
  const positive = delta > 0
  return (
    <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-semibold ${
      positive ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
    }`}>
      {positive ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}
    </span>
  )
}
