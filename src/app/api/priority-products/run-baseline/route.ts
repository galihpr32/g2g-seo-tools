import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { fetchSerpForMarket, ourDomainsForSite, TIER_MARKET_CODES, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 300

/**
 * POST /api/priority-products/run-baseline
 *
 * One-click "snapshot SERP rankings RIGHT NOW for all my tier products" —
 * useful as a baseline before the next weekly cron tick (e.g. after a fresh
 * keyword upload). Auth via session, scoped to current owner × active site.
 *
 * Internally identical to the weekly cron but:
 *   • Limited to the calling owner + active site_slug (not all owners)
 *   • Idempotent — same UNIQUE(owner, product, keyword, market, date) upsert
 *
 * Returns: { products, keywords, markets, calls, inserted, failed }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const today = new Date().toISOString().slice(0, 10)

  // 1. Tier products for this owner × site
  const { data: products } = await db
    .from('product_tiers')
    .select('id, product_name, url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (!products?.length) {
    return NextResponse.json({ ok: true, products: 0, message: `No tier products configured for site=${siteSlug}.` })
  }

  // 2. Keywords for those products
  const productIds = products.map(p => p.id)
  const { data: keywords } = await db
    .from('tier_keywords')
    .select('id, product_tier_id, keyword')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)

  if (!keywords?.length) {
    return NextResponse.json({
      ok: true,
      products: products.length,
      keywords: 0,
      message: 'No keywords yet. Add keywords on each Priority Product detail page first.',
    })
  }

  const kwByProduct: Record<string, typeof keywords> = {}
  for (const k of keywords) {
    kwByProduct[k.product_tier_id] ??= []
    kwByProduct[k.product_tier_id].push(k)
  }

  const ourDomains = ourDomainsForSite(siteSlug)
  if (ourDomains.length === 0) {
    return NextResponse.json({ error: `Unknown site_slug "${siteSlug}" — no domain mapping.` }, { status: 400 })
  }

  // 3. Iterate kw × market in sequence (DataForSEO + Supabase write per call)
  let calls = 0, inserted = 0, failed = 0
  for (const product of products) {
    const kws = kwByProduct[product.id] ?? []
    for (const kw of kws) {
      for (const market of TIER_MARKET_CODES) {
        calls++
        try {
          const result = await fetchSerpForMarket(kw.keyword, market as TierMarket, ourDomains, 50)
          const { error: upsertErr } = await db
            .from('tier_serp_snapshots')
            .upsert({
              owner_user_id:   ownerId,
              product_tier_id: product.id,
              tier_keyword_id: kw.id,
              keyword:         kw.keyword,
              market,
              snapshot_date:   today,
              our_position:    result.ourPosition,
              our_url:         result.ourUrl,
              top_10:          result.top10,
              total_results:   result.totalResults,
              captured_at:     new Date().toISOString(),
            }, { onConflict: 'owner_user_id,product_tier_id,keyword,market,snapshot_date' })
          if (upsertErr) failed++; else inserted++
        } catch (e) {
          failed++
          console.warn(`[run-baseline] ${kw.keyword} @ ${market}:`, e instanceof Error ? e.message : e)
        }
      }
    }
  }

  // Light cost-tracking log
  if (calls > 0) {
    await db.from('api_usage_logs').insert({
      api_name:   'dataforseo',
      endpoint:   'tier_serp_baseline_manual',
      call_count: calls,
      metadata:   { owner_id: ownerId, site_slug: siteSlug, products: products.length, keywords: keywords.length },
      created_at: new Date().toISOString(),
    })
  }

  return NextResponse.json({
    ok:        true,
    site_slug: siteSlug,
    products:  products.length,
    keywords:  keywords.length,
    markets:   TIER_MARKET_CODES.length,
    calls,
    inserted,
    failed,
    date:      today,
  })
}
