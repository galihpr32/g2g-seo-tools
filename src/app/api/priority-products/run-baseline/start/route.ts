import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { TIER_MARKET_CODES } from '@/lib/ranking-tracker'

export const maxDuration = 30

/**
 * POST /api/priority-products/run-baseline/start
 *
 * Sprint SERP.CHUNKED — creates a long-running SERP baseline job.
 *
 * Why this exists: legacy /run-baseline (single-shot) ran ~1,050 calls
 * sequentially and hit Vercel's 300s function timeout after ~150 calls.
 * This endpoint just ENQUEUES the work into serp_baseline_runs.pending
 * and returns instantly. The actual DataForSEO calls happen in /tick.
 *
 * Body: { scope?: 'all'|'tier1'|'tier2' }   (default 'all')
 * Returns: { run_id, total_pairs, products, keywords, markets }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { scope?: 'all' | 'tier1' | 'tier2' }
  const scope = body.scope ?? 'all'

  // 1. Load tier products for this owner × site, filtered by scope
  let productsQ = db
    .from('product_tiers')
    .select('id, product_name, url, tier')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  if (scope === 'tier1') productsQ = productsQ.eq('tier', 1)
  if (scope === 'tier2') productsQ = productsQ.eq('tier', 2)

  const { data: products } = await productsQ
  if (!products?.length) {
    return NextResponse.json({ ok: false, error: `No tier products for scope='${scope}' on site=${siteSlug}` }, { status: 400 })
  }

  // 2. Load keywords for those products
  const productIds = products.map(p => p.id)
  const { data: keywords } = await db
    .from('tier_keywords')
    .select('id, product_tier_id, keyword')
    .eq('owner_user_id', ownerId)
    .in('product_tier_id', productIds)

  if (!keywords?.length) {
    return NextResponse.json({ ok: false, error: 'No keywords on any tier product — add keywords first' }, { status: 400 })
  }

  // 3. Build pending pair list. Each entry is the minimum needed to fetch +
  //    upsert one snapshot — denormalised so /tick doesn't have to re-join.
  type Pair = { product_id: string; keyword_id: string; keyword: string; market: string }
  const pairs: Pair[] = []
  const kwByProduct: Record<string, typeof keywords> = {}
  for (const k of keywords) {
    kwByProduct[k.product_tier_id] ??= []
    kwByProduct[k.product_tier_id].push(k)
  }
  for (const product of products) {
    const kws = kwByProduct[product.id] ?? []
    for (const kw of kws) {
      for (const market of TIER_MARKET_CODES) {
        pairs.push({
          product_id: product.id,
          keyword_id: kw.id,
          keyword:    kw.keyword,
          market,
        })
      }
    }
  }

  // 4. Cancel any currently-running run for this (owner × site) so the UI
  //    can't accidentally have two concurrent runs writing snapshots.
  await db
    .from('serp_baseline_runs')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .in('status',        ['pending', 'running'])

  // 5. Create the new run row
  const { data: run, error: insertErr } = await db
    .from('serp_baseline_runs')
    .insert({
      owner_user_id:   ownerId,
      site_slug:       siteSlug,
      scope,
      status:          'pending',
      total_pairs:     pairs.length,
      processed_pairs: 0,
      failed_pairs:    0,
      pending:         pairs,
    })
    .select('id')
    .single()

  if (insertErr || !run) {
    return NextResponse.json({ ok: false, error: insertErr?.message ?? 'Failed to create run' }, { status: 500 })
  }

  return NextResponse.json({
    ok:          true,
    run_id:      run.id,
    total_pairs: pairs.length,
    products:    products.length,
    keywords:    keywords.length,
    markets:     TIER_MARKET_CODES.length,
    scope,
  })
}
