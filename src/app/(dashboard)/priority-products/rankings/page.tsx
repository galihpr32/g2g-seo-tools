'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSiteSlug } from '@/lib/hooks/useSiteSlug'
import { TIER_MARKETS, TIER_MARKET_CODES, type TierMarket } from '@/lib/ranking-tracker'
import { detectBrandSearch, detectLanguage } from '@/lib/priority-products/discovery-claim'

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
  // Sprint PP.GSC.TOGGLE.2 — GSC-only extras, null in DFS mode
  totalImpressions?:      number | null
  totalImpressionsDelta?: number | null
  totalClicks?:           number | null
  totalClicksDelta?:      number | null
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
  id:               string
  productName:      string
  tier:             1 | 2
  category:         string | null
  url:              string | null
  restriction_type: string | null   // Sprint DMCA.TAGGING — 'DMCA' | 'Trademark' | 'RegionLock' | 'TOS' | null
  market:           'us' | 'id'      // Sprint TIER.PER.MARKET
  kwCount:          number
  matchedKws?:      number | null   // Sprint PP.GSC.MATCH.HINT — GSC-impressions-matched kw count
  avgPosition:      number | null
  top3:             number
  top10:            number
  wowDelta:         number | null
  // Sprint PP.GSC.TOGGLE.2 — GSC-only extras
  impressions?:     number | null
  clicks?:          number | null
}

// Sprint PP.GSC.TOGGLE.2 — discovery rows when source='gsc-discovery'
interface DiscoveryRow {
  productId:   string
  productName: string
  query:       string
  impressions: number
  clicks:      number
  avgPosition: number
  isTracked:   boolean
}

interface CompetitorRow {
  domain:        string
  kwOutranking:  number
  avgPos:        number
}

interface ApiBundle {
  source?:     'dfs' | 'gsc' | 'gsc-discovery'   // Sprint PP.GSC.TOGGLE.2
  filters:     Record<string, string>
  kpis:        Kpis
  distribution: DistributionPoint[]
  topMovers:   { gainers: Mover[]; losers: Mover[] }
  products:    ProductSummary[]
  competitors: CompetitorRow[]
  categories:  string[]
  markets:     readonly string[]
  // Sprint PP.GSC.TOGGLE.2 — present in GSC modes only
  meta?: {
    windowStart: string | null
    windowEnd:   string | null
    priorStart:  string | null
    priorEnd:    string | null
    snapshotsScanned: number
    queriesMatched:   number
  }
  // Sprint PP.GSC.TOGGLE.2 — present in gsc-discovery mode only
  discoveryRows?: DiscoveryRow[]
}

type Source = 'dfs' | 'gsc' | 'gsc-discovery'

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

// Sprint PP.GSC.MATCH.HINT — GSC mode swaps the DFS detail bundle with this
// shape from /api/priority-products/[id]/gsc-leaderboard.
interface GscLeaderboardBundle {
  leaderboard: Array<{
    keyword:       string
    language:      string | null
    is_main:       boolean
    has_signal:    boolean
    impressions:   number
    clicks:        number
    ctr:           number
    avgPosition:   number | null
    priorPosition: number | null
    deltaPosition: number | null
    latestDate:    string | null
    // Sprint PP.GSC.KEYWORD.ANCHOR — page diagnostics
    topPage?:      string | null
    topPageShare?: number | null   // % of impressions on the top page
    distinctPages?: number
  }>
  matched:     number
  total:       number
  productName: string
  productUrl:  string
  error?:      string
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

  // Sprint PP.GSC.TOGGLE.2 — data source toggle
  // Read initial source from URL so back/forward + bookmarking work
  const initialSource = (typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('source')
    : null) as Source | null
  const [source, setSource] = useState<Source>(initialSource ?? 'dfs')

  // Sprint PP.DISCOVERY.CLAIM.1 — refresh trigger bumped after claim succeeds
  // so the discovery table re-fetches and the just-claimed row flips to TRACKED.
  const [refreshTrigger, setRefreshTrigger] = useState(0)

  // Filter state
  const [tier,     setTier]     = useState<'all' | '1' | '2'>('all')
  const [market,   setMarket]   = useState<string>('all')
  const [category, setCategory] = useState<string>('all')
  // Canonical service_name filter (drawn from G2G catalog). Coexists with the
  // free-form `category` filter — service is more reliable across BDT typos
  // because it joins via relation_id to g2g_products.
  const [service,  setService]  = useState<string>('all')
  const [services, setServices] = useState<string[]>([])
  const [range,    setRange]    = useState<string>('1w')
  const [search,   setSearch]   = useState('')
  // Sprint RANKINGS.UX — client-side bucket filter by avgPosition range
  const [bucket,   setBucket]   = useState<'all' | 'top3' | 'top10' | 'top20' | 'top50' | 'outside' | 'notRanking'>('all')
  // Sprint DMCA.TAGGING — client-side filter by restriction_type
  const [restriction, setRestriction] = useState<'all' | 'any' | 'none' | 'DMCA' | 'Trademark' | 'RegionLock' | 'TOS'>('all')

  // Load the 9 canonical service categories once
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/g2g-catalog/stats')
        if (res.ok) {
          const data = await res.json() as { by_service_name?: { service_name: string }[] }
          setServices((data.by_service_name ?? []).map(r => r.service_name))
        }
      } catch { /* silent — falls back to "no canonical filter" */ }
    })()
  }, [])

  // Expanded row state — which products show their keyword × market leaderboard
  // inline. Lazy-loaded from /api/priority-products/[id] on first expand.
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set())
  const [detailCache,    setDetailCache]    = useState<Record<string, ProductDetailBundle>>({})
  const [gscDetailCache, setGscDetailCache] = useState<Record<string, GscLeaderboardBundle>>({})
  const [detailLoading,  setDetailLoading]  = useState<Set<string>>(new Set())

  async function toggleExpand(productId: string) {
    const next = new Set(expanded)
    if (next.has(productId)) {
      next.delete(productId)
      setExpanded(next)
      return
    }
    next.add(productId)
    setExpanded(next)

    // Sprint PP.GSC.MATCH.HINT — pick endpoint by current source
    if (source === 'dfs' && detailCache[productId]) return
    if (source !== 'dfs' && gscDetailCache[productId]) return

    setDetailLoading(prev => new Set(prev).add(productId))
    try {
      const url = source === 'dfs'
        ? `/api/priority-products/${productId}`
        : `/api/priority-products/${productId}/gsc-leaderboard`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (source === 'dfs') setDetailCache(prev => ({ ...prev, [productId]: body as ProductDetailBundle }))
      else                  setGscDetailCache(prev => ({ ...prev, [productId]: body as GscLeaderboardBundle }))
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
    const params = new URLSearchParams({ source, tier, market, category, service, range })
    fetch(`/api/priority-products/rankings?${params.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((body: ApiBundle) => { if (!cancelled) setData(body) })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [source, tier, market, category, service, range, siteSlug, refreshTrigger])

  // Sprint PP.GSC.TOGGLE.2 — keep source in URL for share-ability
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (source === 'dfs') url.searchParams.delete('source')
    else                  url.searchParams.set('source', source)
    window.history.replaceState({}, '', url.toString())
  }, [source])

  // Sprint PP.GSC.MATCH.HINT — when source flips, collapse all expanded rows so
  // user doesn't see stale leaderboard from the other source's cache.
  useEffect(() => {
    setExpanded(new Set())
  }, [source])

  const filteredProducts = useMemo(() => {
    if (!data) return []
    const s = search.trim().toLowerCase()
    return data.products.filter(p => {
      // Text search filter
      if (s && !p.productName.toLowerCase().includes(s) && !(p.category ?? '').toLowerCase().includes(s)) {
        return false
      }
      // Sprint DMCA.TAGGING — restriction filter
      if (restriction !== 'all') {
        const r = p.restriction_type
        if (restriction === 'none' && r !== null) return false
        if (restriction === 'any'  && r === null) return false
        if (restriction !== 'none' && restriction !== 'any' && r !== restriction) return false
      }
      // Sprint RANKINGS.UX — bucket filter by avgPosition
      if (bucket === 'all') return true
      const ap = p.avgPosition
      if (bucket === 'notRanking') return ap == null
      if (ap == null) return false   // exclude unranked from numbered buckets
      if (bucket === 'top3')    return ap >= 1 && ap <= 3
      if (bucket === 'top10')   return ap > 3 && ap <= 10
      if (bucket === 'top20')   return ap > 10 && ap <= 20
      if (bucket === 'top50')   return ap > 20 && ap <= 50
      if (bucket === 'outside') return ap > 50
      return true
    })
  }, [data, search, bucket, restriction])

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
            {source === 'dfs'           && <> Data refreshed weekly from DataForSEO across {TIER_MARKET_CODES.length} markets.</>}
            {source === 'gsc'           && <> GSC impression-weighted average position, 7d rolling with 4d lag, WoW vs prior 28d.</>}
            {source === 'gsc-discovery' && <> Top GSC queries per product URL — surfaces what people actually search for, regardless of curated keywords.</>}
          </p>
          {(source !== 'dfs') && data?.meta?.windowStart && (
            <p className="text-[10px] text-gray-500 mt-1">
              Latest snapshot: <strong className="text-gray-300">{data.meta.windowStart}</strong>
              {data.meta.priorStart && <> · Prior snapshot: <strong className="text-gray-300">{data.meta.priorStart}</strong></>}
              {' · '}{data.meta.snapshotsScanned.toLocaleString()} GSC rows scanned · {data.meta.queriesMatched.toLocaleString()} matched
            </p>
          )}
          {(source !== 'dfs') && !data?.meta?.windowStart && data && !loading && (
            <p className="text-[11px] text-amber-300 mt-1">
              ⚠ No GSC snapshots found for this site yet. Run a <Link href="/hugin" className="underline">Hugin baseline scan</Link> to backfill historical data (30 days recommended) — it&apos;ll populate this view immediately.
            </p>
          )}
        </div>
        <Link
          href="/priority-products"
          className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700"
        >
          📦 Product cards →
        </Link>
      </div>

      {/* Sprint PP.GSC.TOGGLE.2 — Data source toggle */}
      <div className="bg-gray-900/50 border border-gray-800 rounded-xl p-2 mb-3 flex items-center gap-2 flex-wrap text-xs">
        <span className="text-gray-500 px-1">Data source:</span>
        <div className="inline-flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          <SourcePill active={source === 'dfs'}           onClick={() => setSource('dfs')}>           DFS (tracked)        </SourcePill>
          <SourcePill active={source === 'gsc'}           onClick={() => setSource('gsc')}>           GSC                  </SourcePill>
          <SourcePill active={source === 'gsc-discovery'} onClick={() => setSource('gsc-discovery')}> GSC + Discovery 🔍   </SourcePill>
        </div>
        <span className="text-[10px] text-gray-500 ml-1">
          {source === 'dfs'           && 'External view — DataForSEO weekly SERP scrape'}
          {source === 'gsc'           && 'Real performance — what Google reports for our tracked kws'}
          {source === 'gsc-discovery' && 'Untracked winners — top GSC queries per product URL'}
        </span>
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
        <select value={category} onChange={e => setCategory(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white" title="Free-form category from tier admin">
          <option value="all">All categories</option>
          {(data?.categories ?? []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {services.length > 0 && (
          <select value={service} onChange={e => setService(e.target.value)} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white" title="Canonical CMS category from G2G catalog">
            <option value="all">All CMS categories</option>
            {services.map(s => <option key={s} value={s}>📚 {s}</option>)}
          </select>
        )}

        {/* Sprint DMCA.TAGGING — restriction filter */}
        <select
          value={restriction}
          onChange={e => setRestriction(e.target.value as typeof restriction)}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white"
          title="Filter by legal/platform restriction (DMCA, Trademark, RegionLock, TOS)"
        >
          <option value="all">All restrictions</option>
          <option value="none">✅ Unrestricted</option>
          <option value="any">🚫 Any restricted</option>
          <option value="DMCA">🚫 DMCA</option>
          <option value="Trademark">™️ Trademark</option>
          <option value="RegionLock">🌐 Region Lock</option>
          <option value="TOS">⚠️ TOS</option>
        </select>

        {/* Sprint RANKINGS.UX — bucket filter by avgPosition */}
        <select
          value={bucket}
          onChange={e => setBucket(e.target.value as typeof bucket)}
          className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-white"
          title="Filter products by their average ranking position"
        >
          <option value="all">All positions</option>
          <option value="top3">🟢 Top 3 (#1–3)</option>
          <option value="top10">🔵 Top 10 (#4–10)</option>
          <option value="top20">🟠 #11–20</option>
          <option value="top50">🟡 #21–50</option>
          <option value="outside">⚪ #51+</option>
          <option value="notRanking">❌ Not ranking</option>
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
          {/* KPI Strip — DFS = 5 cards, GSC adds Impressions + Clicks (7 cards) */}
          <div className={`grid grid-cols-2 ${source === 'gsc' ? 'md:grid-cols-7' : 'md:grid-cols-5'} gap-3 mb-6`}>
            <KpiCard label="Keywords tracked" value={data.kpis.kwTracked.toString()} accent="#6366f1" />
            <KpiCard
              label={source === 'gsc' ? 'Avg position (impression-weighted)' : 'Avg position'}
              value={data.kpis.avgPosition != null ? `#${data.kpis.avgPosition.toFixed(1)}` : '—'}
              delta={data.kpis.avgPositionDelta}
              deltaLabel={source === 'dfs' ? `vs ${RANGE_LABELS[range]} ago` : 'vs prior 28d'}
              accent="#f59e0b"
              positiveIsGood
            />
            <KpiCard
              label={source === 'gsc' ? 'Top 3 (≤3.5)' : 'Top 3'}
              value={data.kpis.top3.toString()}
              delta={data.kpis.top3Delta}
              deltaLabel={source === 'dfs' ? 'WoW' : '28d Δ'}
              accent="#10b981"
              positiveIsGood
            />
            <KpiCard
              label="Top 10"
              value={data.kpis.top10.toString()}
              delta={data.kpis.top10Delta}
              deltaLabel={source === 'dfs' ? 'WoW' : '28d Δ'}
              accent="#3b82f6"
              positiveIsGood
            />
            <KpiCard
              label="Not ranking"
              value={data.kpis.notRanking.toString()}
              delta={data.kpis.notRankingDelta}
              deltaLabel={source === 'dfs' ? 'WoW' : '28d Δ'}
              accent="#ef4444"
              positiveIsGood={false}
            />
            {source === 'gsc' && data.kpis.totalImpressions != null && (
              <KpiCard
                label="Impressions (7d)"
                value={data.kpis.totalImpressions.toLocaleString()}
                delta={data.kpis.totalImpressionsDelta ?? null}
                deltaLabel="28d Δ"
                accent="#a855f7"
                positiveIsGood
              />
            )}
            {source === 'gsc' && data.kpis.totalClicks != null && (
              <KpiCard
                label="Clicks (7d)"
                value={data.kpis.totalClicks.toLocaleString()}
                delta={data.kpis.totalClicksDelta ?? null}
                deltaLabel="28d Δ"
                accent="#22d3ee"
                positiveIsGood
              />
            )}
          </div>

          {/* Sprint PP.GSC.TOGGLE.2 — Discovery mode renders its own flat table */}
          {source === 'gsc-discovery' ? (
            <DiscoverySection
              rows={data.discoveryRows ?? []}
              search={search}
              siteSlug={siteSlug}
              onClaimed={() => setRefreshTrigger(n => n + 1)}
            />
          ) : (<>
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
                    <th
                      className="text-right px-3 py-2"
                      title={source === 'dfs' ? 'Total tracked keywords' : 'GSC-matched (with impressions) / Total tracked. Untracked = 0 impressions in window.'}
                    >
                      {source === 'dfs' ? 'KWs' : 'KWs (matched/total)'}
                    </th>
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
                    // Sprint PP.GSC.MATCH.HINT — fade rows with 0 GSC signal so the
                    // "no impressions" state is obvious at a glance.
                    const noGscSignal = source !== 'dfs' && p.matchedKws === 0 && p.kwCount > 0
                    return (
                      <Fragment key={p.id}>
                        <tr
                          className={`border-t border-gray-800 hover:bg-gray-800/30 cursor-pointer ${noGscSignal ? 'opacity-50' : ''}`}
                          onClick={() => toggleExpand(p.id)}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-gray-500 text-xs transition-transform inline-block ${isOpen ? 'rotate-90' : ''}`}>▸</span>
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <p className="text-white font-medium truncate">{p.productName}</p>
                                  <RestrictionBadge restriction={p.restriction_type} />
                                  {noGscSignal && (
                                    <span
                                      title="No GSC impressions for any tracked keyword in the current window"
                                      className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600 italic"
                                    >
                                      no GSC signal
                                    </span>
                                  )}
                                </div>
                                {p.url && <p className="text-[10px] text-gray-500 truncate">{p.url}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                                p.tier === 1 ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                              }`}>T{p.tier}</span>
                              <span
                                title={p.market === 'id' ? 'Indonesia market' : 'Global / US market'}
                                className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                                  p.market === 'id'
                                    ? 'bg-red-500/15 text-red-300 border-red-500/30'
                                    : 'bg-blue-500/15 text-blue-300 border-blue-500/30'
                                }`}
                              >
                                {p.market === 'id' ? '🇮🇩' : '🌐'}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-gray-400 hidden md:table-cell text-xs">{p.category ?? '—'}</td>
                          <td className="px-3 py-2.5 text-right text-gray-200">
                            {source === 'dfs'
                              ? p.kwCount
                              : (
                                <span title={`${p.matchedKws ?? 0} of ${p.kwCount} tier keywords have GSC impressions in the current window`}>
                                  <span className={(p.matchedKws ?? 0) === 0 ? 'text-gray-600' : 'text-gray-200'}>
                                    {p.matchedKws ?? 0}
                                  </span>
                                  <span className="text-gray-600">/{p.kwCount}</span>
                                </span>
                              )
                            }
                          </td>
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
                              ) : source === 'dfs' ? (
                                !detail || detail.leaderboard.length === 0 ? (
                                  <p className="text-xs text-gray-500 italic">
                                    No keyword data yet. <Link href={`/priority-products/${p.id}`} className="text-blue-400 hover:text-blue-300">Open detail page</Link> to add keywords.
                                  </p>
                                ) : (
                                  <KeywordLeaderboard rows={detail.leaderboard} markets={detail.markets} />
                                )
                              ) : (
                                // Sprint PP.GSC.MATCH.HINT — GSC mode leaderboard
                                !gscDetailCache[p.id] || gscDetailCache[p.id].leaderboard.length === 0 ? (
                                  <p className="text-xs text-gray-500 italic">
                                    No tracked keywords for this product. <Link href={`/priority-products/${p.id}`} className="text-blue-400 hover:text-blue-300">Add some</Link> first.
                                  </p>
                                ) : (
                                  <GscKeywordLeaderboard bundle={gscDetailCache[p.id]} />
                                )
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

          {/* Outranking Competitors — DFS only (GSC doesn't expose competitor SERPs) */}
          {source === 'dfs' && (
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
          )}
          {source === 'gsc' && (
            <p className="text-[11px] text-gray-500 italic py-2 px-1">
              Note: Outranking Competitors data only available in DFS mode (GSC API doesn&apos;t expose SERP for other domains).
            </p>
          )}
          </>)}
        </>
      )}
    </div>
  )
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

// Sprint PP.GSC.MATCH.HINT — GSC-mode inline leaderboard (replaces DFS market-grid)
function GscKeywordLeaderboard({ bundle }: { bundle: GscLeaderboardBundle }) {
  const { leaderboard, matched, total } = bundle
  // Find a representative latest date from the rows (use the most recent non-null)
  const dates = leaderboard.map(r => r.latestDate).filter(Boolean) as string[]
  const latestDate = dates.length ? dates.sort().reverse()[0] : null

  return (
    <div>
      <div className="flex items-center justify-between mb-2 text-[10px] text-gray-500">
        <span>
          GSC keyword leaderboard · <strong className="text-gray-300">{matched}/{total}</strong> with signal in window
          {latestDate && <> · latest snapshot {latestDate}</>}
        </span>
        {bundle.error && <span className="text-amber-300">{bundle.error}</span>}
      </div>
      <table className="w-full text-xs">
        <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
          <tr>
            <th className="text-left  px-2 py-1.5">Keyword</th>
            <th className="text-center px-2 py-1.5 w-16">Lang</th>
            <th className="text-right  px-2 py-1.5 w-20">Avg Pos</th>
            <th className="text-right  px-2 py-1.5 w-16">Δ 28d</th>
            <th className="text-right  px-2 py-1.5 w-24">Impressions</th>
            <th className="text-right  px-2 py-1.5 w-20">Clicks</th>
            <th className="text-right  px-2 py-1.5 w-16">CTR</th>
            <th className="text-left  px-2 py-1.5">Top page</th>
          </tr>
        </thead>
        <tbody>
          {leaderboard.map((r, i) => (
            <tr key={`${r.keyword}-${i}`} className={`border-t border-gray-800 ${!r.has_signal ? 'opacity-40' : ''}`}>
              <td className="px-2 py-1.5 text-white">
                {r.is_main && <span className="text-yellow-400 mr-1">★</span>}
                {r.keyword}
                {!r.has_signal && (
                  <span className="ml-2 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600 italic">
                    no signal
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-center">
                <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-gray-800 text-gray-300 border border-gray-700">
                  {(r.language ?? 'en').toUpperCase()}
                </span>
              </td>
              <td className="px-2 py-1.5 text-right">
                <PositionCell position={r.avgPosition} />
              </td>
              <td className="px-2 py-1.5 text-right">
                <DeltaPill delta={r.deltaPosition} />
              </td>
              <td className="px-2 py-1.5 text-right text-gray-200">{r.impressions.toLocaleString()}</td>
              <td className="px-2 py-1.5 text-right text-gray-200">{r.clicks.toLocaleString()}</td>
              <td className="px-2 py-1.5 text-right text-gray-400">{r.ctr.toFixed(1)}%</td>
              <td className="px-2 py-1.5">
                {r.topPage ? (
                  <div className="flex flex-col">
                    <a
                      href={r.topPage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[10px] text-blue-400 hover:text-blue-300 truncate max-w-[260px]"
                      title={r.topPage}
                    >
                      {(() => {
                        try { return new URL(r.topPage).pathname }
                        catch { return r.topPage }
                      })()}
                    </a>
                    {r.distinctPages != null && r.distinctPages > 1 && (
                      <span className="text-[9px] text-gray-600">
                        {r.topPageShare}% of {r.distinctPages} pages
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-[10px] text-gray-600">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Sprint PP.GSC.TOGGLE.2 — pill toggle for data source
function SourcePill({ active, onClick, children }: {
  active:   boolean
  onClick:  () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-xs whitespace-nowrap transition ${
        active
          ? 'bg-violet-500/20 text-violet-200 border border-violet-500/40 font-medium'
          : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/60 border border-transparent'
      }`}
    >
      {children}
    </button>
  )
}

// Sprint PP.GSC.TOGGLE.2 — discovery view (gsc-discovery mode)
// Sprint PP.DISCOVERY.CLAIM.1 — claim UNTRACKED → tier_keywords with brand
// search filter, language auto-detect, and confirmation modal.

interface ClaimTarget { productId: string; productName: string; query: string; language: 'en' | 'id' }

function DiscoverySection({ rows, search, siteSlug, onClaimed }: {
  rows:        DiscoveryRow[]
  search:      string
  siteSlug:    string
  onClaimed:   () => void
}) {
  const [hideBrand, setHideBrand] = useState(true)
  const [selected,  setSelected]  = useState<Set<string>>(new Set())
  const [claimModal, setClaimModal] = useState<ClaimTarget[] | null>(null)

  // Annotate rows with brand-search flag once per render
  const enrichedRows = useMemo(() => rows.map(r => ({
    ...r,
    isBrand: detectBrandSearch(r.query, siteSlug),
  })), [rows, siteSlug])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return enrichedRows.filter(r => {
      if (hideBrand && r.isBrand) return false
      if (!s) return true
      return r.productName.toLowerCase().includes(s) || r.query.toLowerCase().includes(s)
    })
  }, [enrichedRows, search, hideBrand])

  const visibleRows = filtered.slice(0, 300)
  const rowKey = (r: DiscoveryRow) => `${r.productId}|${r.query}`

  const selectableKeys = visibleRows.filter(r => !r.isTracked).map(rowKey)
  const allSelected    = selectableKeys.length > 0 && selectableKeys.every(k => selected.has(k))

  function toggleOne(k: string) {
    const next = new Set(selected)
    if (next.has(k)) next.delete(k)
    else             next.add(k)
    setSelected(next)
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set())
    else             setSelected(new Set(selectableKeys))
  }
  function buildTarget(r: DiscoveryRow): ClaimTarget {
    return {
      productId:   r.productId,
      productName: r.productName,
      query:       r.query,
      language:    detectLanguage(r.query),
    }
  }
  function openSingle(r: DiscoveryRow) {
    setClaimModal([buildTarget(r)])
  }
  function openBulk() {
    const targets = visibleRows
      .filter(r => !r.isTracked && selected.has(rowKey(r)))
      .map(buildTarget)
    if (targets.length === 0) return
    setClaimModal(targets)
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden mb-6">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-white">🔍 Discovery — Top GSC queries per product</h2>
          <p className="text-[10px] text-gray-500 mt-0.5">
            All GSC queries hitting tier product URLs in last 7d. Untracked rows = potential new keywords to add to tier_keywords.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <label className="inline-flex items-center gap-1.5 text-gray-400 cursor-pointer hover:text-gray-200">
            <input
              type="checkbox"
              checked={hideBrand}
              onChange={e => setHideBrand(e.target.checked)}
              className="accent-violet-500"
            />
            Hide brand searches
          </label>
          {selected.size > 0 && (
            <button
              onClick={openBulk}
              className="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs rounded-md font-medium"
            >
              Claim selected ({selected.size}) →
            </button>
          )}
          <div className="text-gray-500">
            {filtered.length.toLocaleString()} shown · {filtered.filter(r => !r.isTracked).length.toLocaleString()} untracked
          </div>
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="p-6 text-sm text-gray-500">
          No GSC data yet for these products. Make sure GSC connection is configured and snapshots have populated.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-800/40 text-gray-400 text-[10px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="accent-violet-500"
                    title="Select all untracked visible rows"
                  />
                </th>
                <th className="text-left  px-3 py-2">Product</th>
                <th className="text-left  px-3 py-2">Query</th>
                <th className="text-center px-3 py-2 w-20">Status</th>
                <th className="text-right  px-3 py-2 w-24">Avg Pos</th>
                <th className="text-right  px-3 py-2 w-24">Impressions</th>
                <th className="text-right  px-3 py-2 w-20">Clicks</th>
                <th className="text-right  px-3 py-2 w-20">CTR</th>
                <th className="text-center px-3 py-2 w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r, i) => {
                const ctr = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0
                const k = rowKey(r)
                const isSelected = selected.has(k)
                return (
                  <tr
                    key={`${r.productId}-${r.query}-${i}`}
                    className={`border-t border-gray-800 hover:bg-gray-800/30 ${isSelected ? 'bg-violet-500/5' : ''}`}
                  >
                    <td className="px-3 py-2 text-center">
                      {!r.isTracked && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(k)}
                          className="accent-violet-500"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-200 truncate max-w-[180px]">{r.productName}</td>
                    <td className="px-3 py-2 text-white">
                      {r.query}
                      {r.isBrand && (
                        <span className="ml-2 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-300 border border-yellow-500/30">
                          🏷 BRAND
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.isTracked
                        ? <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">TRACKED</span>
                        : <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">UNTRACKED</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PositionCell position={r.avgPosition} />
                    </td>
                    <td className="px-3 py-2 text-right text-gray-200">{r.impressions.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-200">{r.clicks.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right text-gray-400">{ctr.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-center">
                      {!r.isTracked && (
                        <button
                          onClick={() => openSingle(r)}
                          className="text-[11px] px-2 py-1 bg-gray-800 hover:bg-violet-600 hover:text-white text-gray-200 border border-gray-700 hover:border-violet-500 rounded"
                          title={r.isBrand ? 'Heads-up: looks like a brand search — confirm carefully' : 'Add to tier_keywords'}
                        >
                          Claim
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filtered.length > 300 && (
            <p className="px-4 py-2 text-[10px] text-gray-500 italic border-t border-gray-800">
              Showing top 300 of {filtered.length.toLocaleString()} — narrow with search.
            </p>
          )}
        </div>
      )}

      {claimModal && (
        <ClaimConfirmModal
          targets={claimModal}
          onCancel={() => setClaimModal(null)}
          onDone={() => {
            setClaimModal(null)
            setSelected(new Set())
            onClaimed()
          }}
        />
      )}
    </section>
  )
}

// ─── Claim confirmation modal ─────────────────────────────────────────────────

function ClaimConfirmModal({ targets, onCancel, onDone }: {
  targets:  ClaimTarget[]
  onCancel: () => void
  onDone:   () => void
}) {
  // Per-target language state — start from auto-detect, user can override each
  const [perTargetLang, setPerTargetLang] = useState<Record<string, 'en' | 'id'>>(() => {
    const m: Record<string, 'en' | 'id'> = {}
    for (const t of targets) m[`${t.productId}|${t.query}`] = t.language
    return m
  })
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Array<{ key: string; ok: boolean; error?: string }>>([])

  const isBulk = targets.length > 1

  async function submit() {
    setSubmitting(true)
    setResults([])
    const out: Array<{ key: string; ok: boolean; error?: string }> = []
    for (const t of targets) {
      const key = `${t.productId}|${t.query}`
      const language = perTargetLang[key] ?? t.language
      try {
        const res = await fetch(`/api/priority-products/${t.productId}/keywords`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword: t.query, language }),
        })
        if (res.ok) {
          out.push({ key, ok: true })
        } else {
          const body = await res.json().catch(() => ({})) as { error?: string }
          out.push({ key, ok: false, error: body.error ?? `HTTP ${res.status}` })
        }
      } catch (e) {
        out.push({ key, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
      // Optimistic: update results progressively so user sees progress on bulk
      setResults([...out])
    }
    setSubmitting(false)
    // If everything succeeded, auto-close after a short success flash
    if (out.every(r => r.ok)) {
      setTimeout(() => onDone(), 500)
    }
  }

  function forceAllTo(lang: 'en' | 'id') {
    const next: Record<string, 'en' | 'id'> = {}
    for (const t of targets) next[`${t.productId}|${t.query}`] = lang
    setPerTargetLang(next)
  }

  const successCount = results.filter(r => r.ok).length
  const errorCount   = results.filter(r => !r.ok).length

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-white">
            Claim {targets.length === 1 ? '1 keyword' : `${targets.length} keywords`}
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Adds to <code className="text-violet-300">tier_keywords</code>. Cluster will be re-scored on next cron run.
          </p>
        </div>

        {isBulk && (
          <div className="px-5 py-3 border-b border-gray-800 flex items-center gap-3 text-xs">
            <span className="text-gray-400">Force all to:</span>
            <button
              onClick={() => forceAllTo('en')}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded border border-gray-700"
            >🇺🇸 EN</button>
            <button
              onClick={() => forceAllTo('id')}
              className="px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded border border-gray-700"
            >🇮🇩 ID</button>
            <span className="text-gray-500 ml-auto italic">(or override individually below)</span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-3">
          <table className="w-full text-sm">
            <thead className="text-[10px] text-gray-500 uppercase tracking-wider">
              <tr>
                <th className="text-left  px-2 py-1.5">Product</th>
                <th className="text-left  px-2 py-1.5">Keyword</th>
                <th className="text-center px-2 py-1.5 w-24">Language</th>
                <th className="text-center px-2 py-1.5 w-24">Result</th>
              </tr>
            </thead>
            <tbody>
              {targets.map(t => {
                const key = `${t.productId}|${t.query}`
                const lang = perTargetLang[key] ?? t.language
                const result = results.find(r => r.key === key)
                return (
                  <tr key={key} className="border-t border-gray-800">
                    <td className="px-2 py-2 text-gray-300 truncate max-w-[160px]">{t.productName}</td>
                    <td className="px-2 py-2 text-white">{t.query}</td>
                    <td className="px-2 py-2 text-center">
                      <select
                        value={lang}
                        onChange={e => setPerTargetLang({ ...perTargetLang, [key]: e.target.value as 'en' | 'id' })}
                        disabled={submitting || !!result?.ok}
                        className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                      >
                        <option value="en">🇺🇸 EN</option>
                        <option value="id">🇮🇩 ID</option>
                      </select>
                    </td>
                    <td className="px-2 py-2 text-center text-xs">
                      {!result && (submitting ? <span className="text-gray-500">…</span> : <span className="text-gray-600">—</span>)}
                      {result?.ok && <span className="text-emerald-400">✓ added</span>}
                      {result && !result.ok && (
                        <span className="text-red-400" title={result.error}>✗ {result.error?.slice(0, 30) ?? 'failed'}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500">
            {results.length > 0 && (
              <>
                {successCount > 0 && <span className="text-emerald-400">{successCount} added</span>}
                {successCount > 0 && errorCount > 0 && ' · '}
                {errorCount > 0 && <span className="text-red-400">{errorCount} failed</span>}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={submitting}
              className="px-4 py-1.5 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md disabled:opacity-50"
            >
              {results.length > 0 ? 'Close' : 'Cancel'}
            </button>
            {results.length === 0 && (
              <button
                onClick={submit}
                disabled={submitting}
                className="px-4 py-1.5 text-sm bg-violet-600 hover:bg-violet-500 text-white rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Adding…' : 'Confirm'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

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
  // Sprint RANKINGS.UX — hover tooltip with per-date bucket breakdown
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  if (data.length === 0) {
    return <p className="text-xs text-gray-500 py-12 text-center">No snapshots yet. Run /api/cron/tier-serp-weekly to populate.</p>
  }

  const w = 800, h = 220, padding = 32
  const max = Math.max(1, ...data.map(d => d.top3 + d.top10 + d.top20 + d.top50 + d.outside))
  const barW = (w - padding * 2) / data.length
  const yScale = (n: number) => (n / max) * (h - padding * 2)

  const hovered = hoveredIdx != null ? data[hoveredIdx] : null

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Bars stacked */}
        {data.map((d, i) => {
          const x = padding + i * barW
          const colW = Math.max(8, barW - 4)
          const buckets = [
            { v: d.top3,    color: '#10b981', label: 'Top 3'    },
            { v: d.top10,   color: '#3b82f6', label: '4–10'     },
            { v: d.top20,   color: '#f59e0b', label: '11–20'    },
            { v: d.top50,   color: '#fb923c', label: '21–50'    },
            { v: d.outside, color: '#6b7280', label: 'Outside'  },
          ]
          let yOffset = h - padding
          const total = buckets.reduce((s, b) => s + b.v, 0)
          const isHovered = hoveredIdx === i
          return (
            <g
              key={d.date}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Invisible hit area covering full column height for easier hover */}
              <rect x={x} y={padding} width={colW + 4} height={h - padding * 2} fill="transparent" />

              {buckets.map((b, j) => {
                const bh = yScale(b.v)
                const rect = (
                  <rect
                    key={j}
                    x={x} y={yOffset - bh} width={colW} height={bh}
                    fill={b.color}
                    opacity={hoveredIdx == null || isHovered ? 1 : 0.4}
                  />
                )
                yOffset -= bh
                return rect
              })}
              {/* Total label on top of bar when hovered */}
              {isHovered && total > 0 && (
                <text
                  x={x + colW / 2}
                  y={h - padding - yScale(total) - 4}
                  fontSize="9"
                  fill="#ffffff"
                  textAnchor="middle"
                  fontWeight="bold"
                >
                  {total}
                </text>
              )}
              {/* X label */}
              <text x={x + colW / 2} y={h - padding + 12} fontSize="8" fill={isHovered ? '#fff' : '#6b7280'} textAnchor="middle">
                {d.date.slice(5)}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Hover info panel — pinned top-right, doesn't follow cursor */}
      {hovered && (
        <div className="absolute top-1 right-1 bg-gray-950/95 border border-gray-700 rounded-md px-3 py-2 text-xs shadow-lg pointer-events-none min-w-[180px]">
          <div className="text-gray-400 mb-1.5">{hovered.date}</div>
          <div className="space-y-0.5">
            <Row color="#10b981" label="Top 3"   value={hovered.top3}    />
            <Row color="#3b82f6" label="4–10"    value={hovered.top10}   />
            <Row color="#f59e0b" label="11–20"   value={hovered.top20}   />
            <Row color="#fb923c" label="21–50"   value={hovered.top50}   />
            <Row color="#6b7280" label="Outside" value={hovered.outside} />
          </div>
          <div className="border-t border-gray-700 mt-1.5 pt-1.5 flex items-center justify-between text-gray-300">
            <span>Total kws</span>
            <span className="font-mono font-semibold">{hovered.top3 + hovered.top10 + hovered.top20 + hovered.top50 + hovered.outside}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
        <span className="text-gray-300">{label}</span>
      </div>
      <span className="font-mono text-gray-100">{value}</span>
    </div>
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

/**
 * Sprint DMCA.TAGGING — Visual badge that explains WHY a product may rank
 * poorly. Hover for full label, color-coded by restriction severity.
 */
function RestrictionBadge({ restriction }: { restriction: string | null }) {
  if (!restriction) return null
  const map: Record<string, { label: string; icon: string; cls: string; title: string }> = {
    DMCA: {
      label: 'DMCA',  icon: '🚫', cls: 'bg-red-500/15 text-red-300 border-red-500/30',
      title: 'DMCA takedown risk (e.g., HoYoverse) — limits public SEO visibility',
    },
    Trademark: {
      label: 'TM',    icon: '™️', cls: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
      title: 'Trademark protected — restricted brand keywords',
    },
    RegionLock: {
      label: 'Region', icon: '🌐', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
      title: 'Region-licensed content (e.g., China-only) — limits global visibility',
    },
    TOS: {
      label: 'TOS',   icon: '⚠️', cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
      title: 'Platform Terms-of-Service restriction (e.g., Mobile Legends prohibits sale)',
    },
  }
  const meta = map[restriction]
  if (!meta) return null
  return (
    <span
      title={meta.title}
      className={`inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-0.5 rounded border ${meta.cls}`}
    >
      <span>{meta.icon}</span><span>{meta.label}</span>
    </span>
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
