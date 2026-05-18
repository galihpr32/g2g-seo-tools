import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { scoreCluster, persistClusterScoring } from '@/lib/competitive/scorer'
import { getKeywordDifficulty } from '@/lib/dataforseo/client'

export const maxDuration = 60

/**
 * Sprint COMPETITIVE.SCORER.3 — Re-score competitive keywords.
 *
 * POST /api/competitive/rescore
 *   Body: { product_tier_id?: string }   // optional scope
 *
 * If product_tier_id supplied → re-scores only that product's clusters.
 * Otherwise → re-scores ALL tier_keywords for owner+site (weekly cron pattern).
 *
 * Per Sprint COMPETITIVE.SCORER Q1: cluster = (product_tier_id × market).
 * kw.language → market mapping: 'en' → 'us', 'id' → 'id'.
 *
 * Cost note: DataForSEO search_volume bulk endpoint runs once per location.
 * For a typical full re-score: ~340 kws split US/ID = 2 DFS calls = ~$0.0024.
 * Negligible. Run weekly + on-demand from priority product page.
 */

const LANG_TO_MARKET: Record<string, string> = { en: 'us', id: 'id' }

interface PostBody {
  product_tier_id?: string
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as PostBody
  const scopedProductId = body.product_tier_id?.trim() || null

  // ── 1. Pull all tier_keywords + their product context ─────────────────────
  let kwQuery = db
    .from('tier_keywords')
    .select(`
      id, product_tier_id, keyword, language,
      product_tiers!inner ( id, site_slug, product_name, url )
    `)
    .eq('owner_user_id', ownerId)
    .eq('product_tiers.site_slug', siteSlug)

  if (scopedProductId) {
    kwQuery = kwQuery.eq('product_tier_id', scopedProductId)
  }

  const { data: keywords, error: kwErr } = await kwQuery
  if (kwErr) return NextResponse.json({ error: kwErr.message }, { status: 500 })
  if (!keywords || keywords.length === 0) {
    return NextResponse.json({ ok: true, scored: 0, clusters: 0, message: 'No keywords to score' })
  }

  type KeywordRow = {
    id:               string
    product_tier_id:  string
    keyword:          string
    language:         'en' | 'id' | null
    product_tiers:    { id: string; site_slug: string; product_name: string; url: string | null }
                    | Array<{ id: string; site_slug: string; product_name: string; url: string | null }>
  }
  const kwRows = keywords as unknown as KeywordRow[]

  // Resolve our_domain for SERP density (exclude ourselves from competitor count)
  const ourDomain = siteSlug === 'g2g' ? 'g2g.com' : siteSlug === 'offgamers' ? 'offgamers.com' : `${siteSlug}.com`

  // ── 2. Group into clusters (product_tier_id × market) ──────────────────────
  type ClusterKey = string
  const clusters = new Map<ClusterKey, {
    product_tier_id: string
    market:          string
    kws: Array<{ id: string; keyword: string; product_name: string }>
  }>()

  for (const k of kwRows) {
    const market = LANG_TO_MARKET[String(k.language ?? 'en')] ?? 'us'
    const productInfo = Array.isArray(k.product_tiers) ? k.product_tiers[0] : k.product_tiers
    if (!productInfo) continue
    const key = `${k.product_tier_id}|${market}`
    if (!clusters.has(key)) {
      clusters.set(key, {
        product_tier_id: k.product_tier_id,
        market,
        kws:             [],
      })
    }
    clusters.get(key)!.kws.push({
      id:           k.id,
      keyword:      k.keyword,
      product_name: productInfo.product_name,
    })
  }

  // ── 3. Bulk-fetch SV from DataForSEO per market ───────────────────────────
  // Group kws by market (one DFS call per market).
  const kwsByMarket = new Map<string, string[]>()
  for (const c of clusters.values()) {
    const arr = kwsByMarket.get(c.market) ?? []
    for (const k of c.kws) arr.push(k.keyword)
    kwsByMarket.set(c.market, arr)
  }

  const svByKeyword = new Map<string, number | null>()
  for (const [market, kws] of kwsByMarket.entries()) {
    const uniqueKws = Array.from(new Set(kws))
    const locationCode = market === 'id' ? 2360 : 2840   // 2360=ID, 2840=US
    const langCode     = market === 'id' ? 'id'  : 'en'
    try {
      // eslint-disable-next-line no-await-in-loop
      const svMap = await getKeywordDifficulty(uniqueKws, locationCode, langCode)
      for (const [kw, sv] of Object.entries(svMap)) {
        svByKeyword.set(`${kw.toLowerCase()}|${market}`, sv)
      }
    } catch (e) {
      console.warn('[rescore] DataForSEO SV fetch failed for market', market, e instanceof Error ? e.message : e)
    }
  }

  // ── 4. Bulk-fetch latest SERP snapshots per (kw × market) for density ─────
  // We pull the most recent snapshot per (product_tier_id, keyword, market).
  const productIds = Array.from(new Set(Array.from(clusters.values()).map(c => c.product_tier_id)))
  const { data: snapshots } = await db
    .from('tier_serp_snapshots')
    .select('product_tier_id, keyword, market, snapshot_date, top_10')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)
    .order('snapshot_date', { ascending: false })
    .limit(2000)

  type SnapRow = {
    product_tier_id: string
    keyword:         string
    market:          string
    snapshot_date:   string
    top_10:          Array<{ position: number; url: string; domain: string; title: string }>
  }
  const latestTop10 = new Map<string, Array<{ position: number; url: string; domain: string }>>()
  for (const s of (snapshots ?? []) as SnapRow[]) {
    const key = `${s.product_tier_id}|${s.keyword.toLowerCase()}|${s.market}`
    if (latestTop10.has(key)) continue   // first seen = most recent (already ordered DESC)
    latestTop10.set(key, Array.isArray(s.top_10) ? s.top_10 : [])
  }

  // ── 5. Score each cluster + persist ────────────────────────────────────────
  let totalScored = 0
  const clusterSummaries: Array<{
    product_tier_id: string
    market:          string
    kw_count:        number
    top_score:       number
    top_kw:          string | null
    has_top_1:       boolean
  }> = []

  for (const c of clusters.values()) {
    const scoreInputKws = c.kws.map(k => ({
      id:        k.id,
      keyword:   k.keyword,
      sv_volume: svByKeyword.get(`${k.keyword.toLowerCase()}|${c.market}`) ?? null,
      top10:     latestTop10.get(`${c.product_tier_id}|${k.keyword.toLowerCase()}|${c.market}`) ?? null,
    }))

    const scored = scoreCluster({
      product_tier_id: c.product_tier_id,
      cluster_market:  c.market,
      our_domain:      ourDomain,
      keywords:        scoreInputKws,
    })

    // eslint-disable-next-line no-await-in-loop
    const persistRes = await persistClusterScoring(db, ownerId, scored)
    totalScored += persistRes.updated

    clusterSummaries.push({
      product_tier_id: c.product_tier_id,
      market:          c.market,
      kw_count:        scored.kws.length,
      top_score:       scored.top_score,
      top_kw:          scored.kws[0]?.keyword ?? null,
      has_top_1:       scored.has_top_1,
    })
  }

  return NextResponse.json({
    ok:       true,
    scored:   totalScored,
    clusters: clusters.size,
    summary:  clusterSummaries,
  })
}
