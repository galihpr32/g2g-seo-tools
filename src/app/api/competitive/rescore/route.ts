import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { scoreCluster, persistClusterScoring } from '@/lib/competitive/scorer'
import { getKeywordDifficulty, getKeywordVolumesLabs } from '@/lib/dataforseo/client'

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
  const svDiagnostics: Array<{
    market:      string
    requested:   number
    from_ads:    number
    from_labs:   number
    still_null:  number
    error?:      string
  }> = []
  for (const [market, kws] of kwsByMarket.entries()) {
    const uniqueKws = Array.from(new Set(kws))
    const locationCode = market === 'id' ? 2360 : 2840   // 2360=ID, 2840=US
    const langCode     = market === 'id' ? 'id'  : 'en'

    let fromAds  = 0
    let fromLabs = 0
    let lastError: string | undefined

    // Layer 1: Google Ads (cheap, fast — sparse for long-tail gaming)
    try {
      // eslint-disable-next-line no-await-in-loop
      const adsMap = await getKeywordDifficulty(uniqueKws, locationCode, langCode)
      for (const [kw, sv] of Object.entries(adsMap)) {
        if (sv != null && sv > 0) {
          svByKeyword.set(`${kw.toLowerCase()}|${market}`, sv)
          fromAds++
        }
      }
    } catch (e) {
      lastError = `google_ads: ${e instanceof Error ? e.message : String(e)}`
      console.warn('[rescore] Google Ads SV fetch failed for market', market, lastError)
    }

    // Layer 2: DataForSEO Labs fallback — for kws Google Ads didn't cover.
    // Labs uses a clickstream+Bing multi-source database with way better
    // long-tail coverage. ~10x more expensive per kw but only called on the
    // gap subset, so cost stays small.
    const stillNullKws = uniqueKws.filter(kw => !svByKeyword.has(`${kw.toLowerCase()}|${market}`))
    if (stillNullKws.length > 0) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const labsMap = await getKeywordVolumesLabs(stillNullKws, locationCode, langCode)
        for (const [kw, sv] of Object.entries(labsMap)) {
          if (sv != null && sv > 0 && !svByKeyword.has(`${kw.toLowerCase()}|${market}`)) {
            svByKeyword.set(`${kw.toLowerCase()}|${market}`, sv)
            fromLabs++
          }
        }
      } catch (e) {
        const labsErr = `labs: ${e instanceof Error ? e.message : String(e)}`
        lastError = lastError ? `${lastError}; ${labsErr}` : labsErr
        console.warn('[rescore] DataForSEO Labs SV fallback failed for market', market, labsErr)
      }
    }

    svDiagnostics.push({
      market,
      requested:   uniqueKws.length,
      from_ads:    fromAds,
      from_labs:   fromLabs,
      still_null:  uniqueKws.length - fromAds - fromLabs,
      error:       lastError,
    })
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
    // Sprint COMPETITIVE.SCORER.9 — diagnostic so user knows when DataForSEO
    // returned no SV for most kws (formula falls back to density+intent only).
    sv_diagnostics: svDiagnostics,
  })
}
