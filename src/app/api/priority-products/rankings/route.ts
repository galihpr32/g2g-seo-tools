import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { TIER_MARKET_CODES } from '@/lib/ranking-tracker'

export const maxDuration = 30

/**
 * GET /api/priority-products/rankings
 *
 * Aggregate keyword-ranking dashboard data across Tier 1 + Tier 2 products
 * on the active brand. Single endpoint that powers the whole "Rankings
 * Dashboard" page — KPI strip, rankings-distribution chart, top movers,
 * per-product summary, outranking competitors.
 *
 * Query params:
 *   tier:     'all' | '1' | '2'                                    (default all)
 *   market:   'all' | 'us' | 'de' | 'fr' | 'my' | 'id'              (default all)
 *   category: 'all' | <free-form category>                           (default all)
 *   range:    '1d' | '1w' | '4w' | '8w' | '12w'                     (default 1w)
 *
 * Range affects:
 *   • Chart history depth (how far back the distribution chart goes)
 *   • WoW delta comparison (latest snapshot vs N-time-ago snapshot)
 *   • Top-movers calculation
 *
 * Note: tier_serp_snapshots is captured WEEKLY by the
 * /api/cron/tier-serp-weekly job, so sub-weekly ranges (1d) show the latest
 * snapshot only — no trend chart, just current-state KPIs.
 */

const RANGE_WEEKS: Record<string, number> = {
  '1d':  0,    // current snapshot only
  '1w':  1,
  '4w':  4,
  '8w':  8,
  '12w': 12,
}

interface SerpRow {
  product_tier_id: string
  keyword:         string
  market:          string
  snapshot_date:   string
  our_position:    number | null
  our_url:         string | null
  top_10:          Array<{ position: number; url: string; domain: string; title: string }>
}

interface ProductMeta {
  id:               string
  tier:             1 | 2
  product_name:     string
  category:         string | null
  url:              string | null
  relation_id:      string | null
  restriction_type: string | null
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const url      = new URL(req.url)
  const tier     = url.searchParams.get('tier')     ?? 'all'
  const market   = url.searchParams.get('market')   ?? 'all'
  const category = url.searchParams.get('category') ?? 'all'
  // Canonical category filter (from g2g_products.service_name). Preferred
  // over free-form `category` when the catalog has been imported, because
  // it's stable across BDT typos / spelling variants.
  const service  = url.searchParams.get('service')  ?? 'all'
  const range    = url.searchParams.get('range')    ?? '1w'

  const weeksBack = RANGE_WEEKS[range] ?? 1

  // ── 1. Fetch tier products (filtered by tier + category) ───────────────────
  let productsQ = db
    .from('product_tiers')
    .select('id, tier, product_name, category, url, relation_id, restriction_type')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  if (tier === '1') productsQ = productsQ.eq('tier', 1)
  if (tier === '2') productsQ = productsQ.eq('tier', 2)
  if (category !== 'all') productsQ = productsQ.eq('category', category)

  let { data: productsRaw } = await productsQ

  // Apply canonical service filter via a second query against g2g_products.
  if (service !== 'all' && productsRaw && productsRaw.length) {
    const relIds = productsRaw.map(p => p.relation_id).filter(Boolean) as string[]
    if (relIds.length === 0) {
      productsRaw = []
    } else {
      const { data: catalogRows } = await db
        .from('g2g_products')
        .select('relation_id')
        .eq('service_name', service)
        .in('relation_id', relIds)
      const okSet = new Set((catalogRows ?? []).map(r => r.relation_id))
      productsRaw = productsRaw.filter(p => p.relation_id && okSet.has(p.relation_id))
    }
  }

  const products = (productsRaw ?? []) as ProductMeta[]

  if (products.length === 0) {
    return NextResponse.json({
      filters: { tier, market, category, service, range },
      kpis: emptyKpis(),
      distribution: [],
      topMovers: { gainers: [], losers: [] },
      products: [],
      competitors: [],
    })
  }

  const productIds = products.map(p => p.id)
  const productMap = new Map(products.map(p => [p.id, p]))

  // ── 2. Fetch SERP snapshots for these products, last 12 weeks max ──────────
  // We always pull 12 weeks of data so the distribution chart can show full
  // history when range='12w', then filter the WoW comparison in JS based on
  // the selected range. One DB read for everything.
  const since = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString().slice(0, 10)
  let snapsQ = db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, our_position, our_url, top_10')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: false })
  if (market !== 'all') snapsQ = snapsQ.eq('market', market)

  const { data: snapsRaw } = await snapsQ
  const snapshots = (snapsRaw ?? []) as SerpRow[]

  // ── 3. Bucket: latest snapshot per (product × keyword × market) ────────────
  type Bucket = { latest: SerpRow; comparison?: SerpRow; history: SerpRow[] }
  const buckets = new Map<string, Bucket>()
  for (const s of snapshots) {
    const k = `${s.product_tier_id}|${s.keyword}|${s.market}`
    const b = buckets.get(k)
    if (!b) {
      buckets.set(k, { latest: s, history: [s] })
    } else {
      b.history.push(s)
    }
  }

  // For each bucket, identify the comparison snapshot = the one closest to
  // (latest.date - weeksBack * 7 days). If weeksBack=0, no comparison.
  for (const b of buckets.values()) {
    if (weeksBack === 0) continue
    const targetMs = new Date(b.latest.snapshot_date).getTime() - weeksBack * 7 * 86_400_000
    let best: SerpRow | undefined
    let bestDelta = Infinity
    for (const s of b.history) {
      if (s.snapshot_date >= b.latest.snapshot_date) continue
      const d = Math.abs(new Date(s.snapshot_date).getTime() - targetMs)
      if (d < bestDelta) { best = s; bestDelta = d }
    }
    if (best) b.comparison = best
  }

  // ── 4. KPIs (current state from latest snapshots) ──────────────────────────
  let posSum = 0
  let posCount = 0
  let top3 = 0, top10 = 0, top20 = 0, notRanking = 0
  let posSumPrev = 0, posCountPrev = 0
  let top3Prev = 0, top10Prev = 0, notRankingPrev = 0

  for (const b of buckets.values()) {
    const cur = b.latest.our_position
    if (cur != null) {
      posSum += cur
      posCount++
      if (cur <= 3) top3++
      else if (cur <= 10) top10++
      else if (cur <= 20) top20++
    } else {
      notRanking++
    }
    if (b.comparison) {
      const p = b.comparison.our_position
      if (p != null) {
        posSumPrev += p
        posCountPrev++
        if (p <= 3) top3Prev++
        else if (p <= 10) top10Prev++
      } else {
        notRankingPrev++
      }
    }
  }
  const avgPos     = posCount     > 0 ? +(posSum     / posCount).toFixed(1)     : null
  const avgPosPrev = posCountPrev > 0 ? +(posSumPrev / posCountPrev).toFixed(1) : null

  const kpis = {
    kwTracked:       buckets.size,
    avgPosition:     avgPos,
    avgPositionDelta: (avgPos != null && avgPosPrev != null) ? +(avgPosPrev - avgPos).toFixed(1) : null,  // positive = improved
    top3,
    top3Delta:       top3 - top3Prev,
    top10,
    top10Delta:      top10 - top10Prev,
    top20,
    notRanking,
    notRankingDelta: notRanking - notRankingPrev,
  }

  // ── 5. Rankings distribution chart — per-week buckets, last 12 weeks ──────
  // For each calendar week present in snapshots, count keywords in each bucket.
  type Bucket5 = { top3: number; top10: number; top20: number; top50: number; outside: number; date: string }
  const weekly: Record<string, Bucket5> = {}
  // First, find latest snapshot per (product × kw × market) within each week
  for (const s of snapshots) {
    const week = s.snapshot_date  // weekly snapshots — each date IS a week marker
    weekly[week] ??= { top3: 0, top10: 0, top20: 0, top50: 0, outside: 0, date: week }
    const p = s.our_position
    if (p == null)        weekly[week].outside++
    else if (p <= 3)      weekly[week].top3++
    else if (p <= 10)     weekly[week].top10++
    else if (p <= 20)     weekly[week].top20++
    else if (p <= 50)     weekly[week].top50++
    else                  weekly[week].outside++
  }
  const distribution = Object.values(weekly)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-12)   // cap to last 12 weeks

  // ── 6. Top movers — per (kw × market), gainers + losers by position delta ─
  type Mover = {
    productName: string
    keyword:     string
    market:      string
    prevPos:     number | null
    currPos:     number | null
    delta:       number     // positive = improved (was higher pos #, now lower)
  }
  const movers: Mover[] = []
  for (const b of buckets.values()) {
    if (!b.comparison) continue
    const cur  = b.latest.our_position
    const prev = b.comparison.our_position
    if (cur == null && prev == null) continue
    const meta = productMap.get(b.latest.product_tier_id)
    // Movement convention: positive delta = improvement (e.g., #15 → #8 → delta = 7)
    let delta = 0
    if (cur != null && prev != null) delta = prev - cur
    else if (cur == null && prev != null) delta = -50  // fell out
    else if (cur != null && prev == null) delta = +50  // entered ranking
    if (Math.abs(delta) < 1) continue
    movers.push({
      productName: meta?.product_name ?? '(unknown)',
      keyword:     b.latest.keyword,
      market:      b.latest.market,
      prevPos:     prev,
      currPos:     cur,
      delta,
    })
  }
  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  const gainers = movers.filter(m => m.delta > 0).slice(0, 5)
  const losers  = movers.filter(m => m.delta < 0).slice(0, 5)

  // ── 7. Per-product summary ─────────────────────────────────────────────────
  type ProductSummary = {
    id:               string
    productName:      string
    tier:             1 | 2
    category:         string | null
    url:              string | null
    restriction_type: string | null
    kwCount:          number
    avgPosition:      number | null
    top3:             number
    top10:            number
    wowDelta:         number | null   // positive = improved avg pos
  }
  const perProduct = new Map<string, { sum: number; count: number; sumPrev: number; countPrev: number; t3: number; t10: number; kws: Set<string> }>()
  for (const b of buckets.values()) {
    const pid = b.latest.product_tier_id
    const entry = perProduct.get(pid) ?? { sum: 0, count: 0, sumPrev: 0, countPrev: 0, t3: 0, t10: 0, kws: new Set<string>() }
    entry.kws.add(b.latest.keyword)
    if (b.latest.our_position != null) {
      entry.sum += b.latest.our_position
      entry.count++
      if (b.latest.our_position <= 3)  entry.t3++
      else if (b.latest.our_position <= 10) entry.t10++
    }
    if (b.comparison?.our_position != null) {
      entry.sumPrev += b.comparison.our_position
      entry.countPrev++
    }
    perProduct.set(pid, entry)
  }
  const productSummaries: ProductSummary[] = products.map(p => {
    const e = perProduct.get(p.id)
    if (!e || e.kws.size === 0) {
      return {
        id: p.id, productName: p.product_name, tier: p.tier, category: p.category, url: p.url,
        restriction_type: p.restriction_type,
        kwCount: 0, avgPosition: null, top3: 0, top10: 0, wowDelta: null,
      }
    }
    const avg     = e.count     > 0 ? +(e.sum     / e.count).toFixed(1)     : null
    const avgPrev = e.countPrev > 0 ? +(e.sumPrev / e.countPrev).toFixed(1) : null
    return {
      id: p.id, productName: p.product_name, tier: p.tier, category: p.category, url: p.url,
      restriction_type: p.restriction_type,
      kwCount:     e.kws.size,
      avgPosition: avg,
      top3:        e.t3,
      top10:       e.t10,
      wowDelta:    (avg != null && avgPrev != null) ? +(avgPrev - avg).toFixed(1) : null,
    }
  }).sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    return (a.avgPosition ?? 999) - (b.avgPosition ?? 999)
  })

  // ── 8. Outranking competitors — domains in top_10 above our position ─────
  // For each snapshot's top_10, count domains that appear ABOVE our position.
  // Aggregate across all buckets. Skip our own domain.
  const ourDomainHints = ['g2g.com', 'offgamers.com']  // skip ourselves
  const compStats = new Map<string, { count: number; posSum: number; posCount: number }>()
  for (const b of buckets.values()) {
    const ourPos = b.latest.our_position ?? 100
    for (const row of (b.latest.top_10 ?? [])) {
      const dom = (row.domain ?? '').toLowerCase()
      if (!dom) continue
      // Skip our own (incl. subdomains)
      if (ourDomainHints.some(own => dom === own || dom.endsWith('.' + own))) continue
      if (row.position >= ourPos) continue  // only count competitors RANKING ABOVE us
      const cur = compStats.get(dom) ?? { count: 0, posSum: 0, posCount: 0 }
      cur.count++
      cur.posSum += row.position
      cur.posCount++
      compStats.set(dom, cur)
    }
  }
  const competitors = Array.from(compStats.entries())
    .map(([domain, s]) => ({
      domain,
      kwOutranking:   s.count,
      avgPos:         +(s.posSum / s.posCount).toFixed(1),
    }))
    .sort((a, b) => b.kwOutranking - a.kwOutranking)
    .slice(0, 10)

  // ── 9. Distinct categories present (for filter dropdown) ──────────────────
  const allCategories = Array.from(new Set(products.map(p => p.category).filter(Boolean))) as string[]
  allCategories.sort()

  return NextResponse.json({
    filters: { tier, market, category, service, range },
    kpis,
    distribution,
    topMovers: { gainers, losers },
    products: productSummaries,
    competitors,
    categories: allCategories,
    markets:    TIER_MARKET_CODES,
  })
}

function emptyKpis() {
  return {
    kwTracked: 0,
    avgPosition: null,
    avgPositionDelta: null,
    top3: 0, top3Delta: 0,
    top10: 0, top10Delta: 0,
    top20: 0,
    notRanking: 0, notRankingDelta: 0,
  }
}
