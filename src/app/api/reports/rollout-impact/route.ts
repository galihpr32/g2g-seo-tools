import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

/**
 * GET /api/reports/rollout-impact?baseline=YYYY-MM-DD
 *
 * Before/after dashboard for AI rollout. Per (tier product × keyword × market),
 * compares the BASELINE snapshot (configurable date — default: earliest
 * available) vs the LATEST snapshot, returning position deltas.
 *
 * Also rolls up to per-product summary so the UI can render "X products
 * improved, Y declined, Z unchanged".
 *
 * Data sources:
 *   - tier_serp_snapshots (per-keyword × market position over time)
 *   - product_tiers       (the products being tracked)
 */

interface Snapshot {
  product_tier_id: string
  keyword:         string
  market:          string
  snapshot_date:   string
  our_position:    number | null
}

interface PerKeywordDelta {
  keyword:        string
  market:         string
  baseline_pos:   number | null
  latest_pos:     number | null
  pos_change:     number | null   // positive = improved (e.g. 8 → 5 = +3)
  trend:          'improved' | 'declined' | 'unchanged' | 'new' | 'lost'
}

interface PerProductDelta {
  product_id:        string
  product_name:      string
  category:          string | null
  tier:              number
  url:               string | null
  keywords_tracked:  number
  avg_baseline_pos:  number | null
  avg_latest_pos:    number | null
  avg_pos_change:    number | null
  improved:          number
  declined:          number
  unchanged:         number
  new_rankings:      number
  lost_rankings:     number
  health:            'winning' | 'mixed' | 'losing'
  keyword_details:   PerKeywordDelta[]
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const baselineParam = searchParams.get('baseline')   // ISO date or null
  // Sprint #395 — market filter. Default to US + ID only (matches boss
  // view + monthly report scope). Override with ?markets=us,id,de etc.
  const rawMarkets = searchParams.get('markets')
  const markets    = (rawMarkets ? rawMarkets.split(',') : ['us', 'id'])
    .map(m => m.trim().toLowerCase())
    .filter(Boolean)

  // 1. Pull tier products
  const { data: products } = await db
    .from('product_tiers')
    .select('id, product_name, category, tier, url, relation_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (!products?.length) {
    return NextResponse.json({
      products: [],
      summary:  emptySummary(),
      message:  'No tier products configured. Add some at /settings/product-tiers first.',
    })
  }

  // 2. Pull snapshots for these products within the lookback window.
  //
  // Sprint #393 fixes:
  //   (a) Add owner_user_id filter — previously omitted, which let legacy /
  //       other-owner rows tied to the same product_tier_id leak in and
  //       hijack baseline/latest dates (we'd see 2026-05-13 → 2026-05-14
  //       stale May data even when fresh 6/4 snapshots existed).
  //   (b) Add a 60-day lookback. Without it baseline_date = global oldest
  //       snapshot (could be years old) so the comparison never reflects
  //       recent rollout impact. 60 days gives 2-3 monthly runs to compare.
  const productIds = products.map(p => p.id)
  const lookbackDays  = 60
  const lookbackStart = new Date(Date.now() - lookbackDays * 86_400_000)
    .toISOString().slice(0, 10)
  const { data: snaps } = await db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, our_position')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .in('market', markets)                         // Sprint #395 — US + ID only by default
    .gte('snapshot_date', lookbackStart)
    .order('snapshot_date', { ascending: true })

  if (!snaps?.length) {
    return NextResponse.json({
      products: [],
      summary:  emptySummary(),
      message:  'No SERP snapshots yet. Run "⚡ Run SERP baseline" on /priority-products first.',
    })
  }

  // Sprint #394 — density-based baseline picker. Group all snapshots by
  // snapshot_date, count rows per date, then KEEP only dates with row
  // count ≥ 50% of the max row count. This drops partial/test runs (e.g.
  // 1-2 rows on 5/13 from an early bring-up) so baseline picks the first
  // FULL run instead. Then we filter `snaps` to only those qualifying dates.
  const rowCountByDate = new Map<string, number>()
  for (const s of snaps as Snapshot[]) {
    rowCountByDate.set(s.snapshot_date, (rowCountByDate.get(s.snapshot_date) ?? 0) + 1)
  }
  const maxRowCount       = Math.max(0, ...Array.from(rowCountByDate.values()))
  const densityThreshold  = Math.floor(maxRowCount * 0.5)
  const qualifyingDates   = new Set(
    Array.from(rowCountByDate.entries())
      .filter(([, count]) => count >= densityThreshold)
      .map(([date]) => date),
  )
  const filteredSnaps = (snaps as Snapshot[]).filter(s => qualifyingDates.has(s.snapshot_date))

  // 3. Bucket by (product, keyword, market) → list of qualifying snapshots
  type Key = string
  const byKey = new Map<Key, Snapshot[]>()
  for (const s of filteredSnaps) {
    const k = `${s.product_tier_id}|${s.keyword}|${s.market}`
    const arr = byKey.get(k) ?? []
    arr.push(s)
    byKey.set(k, arr)
  }

  // 4. For each combo, compute baseline + latest
  const productDeltas = new Map<string, PerProductDelta>()
  for (const p of products) {
    productDeltas.set(p.id, {
      product_id:       p.id,
      product_name:     p.product_name,
      category:         p.category,
      tier:             p.tier,
      url:              p.url,
      keywords_tracked: 0,
      avg_baseline_pos: null,
      avg_latest_pos:   null,
      avg_pos_change:   null,
      improved:         0,
      declined:         0,
      unchanged:        0,
      new_rankings:     0,
      lost_rankings:    0,
      health:           'mixed',
      keyword_details:  [],
    })
  }

  for (const [k, list] of byKey) {
    const [productId, keyword, market] = k.split('|')
    const pd = productDeltas.get(productId)
    if (!pd) continue

    // Pick baseline: if user supplied, snapshot closest to that date.
    // Otherwise: oldest snapshot for this combo.
    let baselineSnap: Snapshot | null = null
    if (baselineParam) {
      const target = new Date(baselineParam).getTime()
      let bestDiff = Infinity
      for (const s of list) {
        const diff = Math.abs(new Date(s.snapshot_date).getTime() - target)
        if (diff < bestDiff) { bestDiff = diff; baselineSnap = s }
      }
    } else {
      baselineSnap = list[0]
    }
    const latestSnap = list[list.length - 1]
    if (!baselineSnap || !latestSnap) continue

    const baseline = baselineSnap.our_position
    const latest   = latestSnap.our_position
    const change   = (baseline != null && latest != null) ? (baseline - latest) : null
    let trend: PerKeywordDelta['trend'] = 'unchanged'
    if (baseline == null && latest != null)        { trend = 'new';      pd.new_rankings++ }
    else if (baseline != null && latest == null)   { trend = 'lost';     pd.lost_rankings++ }
    else if (change != null && change > 0)          { trend = 'improved'; pd.improved++ }
    else if (change != null && change < 0)          { trend = 'declined'; pd.declined++ }
    else                                             { trend = 'unchanged'; pd.unchanged++ }

    pd.keyword_details.push({ keyword, market, baseline_pos: baseline, latest_pos: latest, pos_change: change, trend })
    pd.keywords_tracked++
  }

  // 5. Roll up avg positions + health per product
  const productSummaries: PerProductDelta[] = []
  let totalImproved = 0, totalDeclined = 0, totalUnchanged = 0, totalNew = 0, totalLost = 0
  for (const pd of productDeltas.values()) {
    if (pd.keywords_tracked === 0) continue
    const baselinePoses = pd.keyword_details.map(k => k.baseline_pos).filter((p): p is number => p != null)
    const latestPoses   = pd.keyword_details.map(k => k.latest_pos).filter((p): p is number => p != null)
    pd.avg_baseline_pos = baselinePoses.length ? Number((baselinePoses.reduce((s, x) => s + x, 0) / baselinePoses.length).toFixed(1)) : null
    pd.avg_latest_pos   = latestPoses.length   ? Number((latestPoses.reduce((s, x) => s + x, 0) / latestPoses.length).toFixed(1))   : null
    pd.avg_pos_change   = (pd.avg_baseline_pos != null && pd.avg_latest_pos != null) ? Number((pd.avg_baseline_pos - pd.avg_latest_pos).toFixed(1)) : null

    const net = pd.improved + pd.new_rankings - pd.declined - pd.lost_rankings
    pd.health = net > 1 ? 'winning' : net < -1 ? 'losing' : 'mixed'

    totalImproved  += pd.improved
    totalDeclined  += pd.declined
    totalUnchanged += pd.unchanged
    totalNew       += pd.new_rankings
    totalLost      += pd.lost_rankings

    productSummaries.push(pd)
  }

  // Sort: winning first, then by avg_pos_change desc
  productSummaries.sort((a, b) => {
    const healthRank = (h: PerProductDelta['health']) => h === 'winning' ? 0 : h === 'mixed' ? 1 : 2
    if (healthRank(a.health) !== healthRank(b.health)) return healthRank(a.health) - healthRank(b.health)
    return (b.avg_pos_change ?? -Infinity) - (a.avg_pos_change ?? -Infinity)
  })

  return NextResponse.json({
    summary: {
      products_with_data: productSummaries.length,
      products_winning:   productSummaries.filter(p => p.health === 'winning').length,
      products_mixed:     productSummaries.filter(p => p.health === 'mixed').length,
      products_losing:    productSummaries.filter(p => p.health === 'losing').length,
      keywords_improved:  totalImproved,
      keywords_declined:  totalDeclined,
      keywords_unchanged: totalUnchanged,
      keywords_new:       totalNew,
      keywords_lost:      totalLost,
      // Sprint #394 — use FILTERED snaps (density-qualified runs only) so
      // baseline shows the first proper run, not a 1-row test snapshot.
      baseline_date: filteredSnaps[0]?.snapshot_date ?? null,
      latest_date:   filteredSnaps[filteredSnaps.length - 1]?.snapshot_date ?? null,
    },
    products: productSummaries,
  })
}

function emptySummary() {
  return {
    products_with_data: 0,
    products_winning:   0,
    products_mixed:     0,
    products_losing:    0,
    keywords_improved:  0,
    keywords_declined:  0,
    keywords_unchanged: 0,
    keywords_new:       0,
    keywords_lost:      0,
    baseline_date:      null,
    latest_date:        null,
  }
}
