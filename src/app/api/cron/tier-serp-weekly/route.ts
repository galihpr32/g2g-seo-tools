import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { fetchSerpForMarket, ourDomainsForSite, TIER_MARKET_CODES, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 300

/**
 * GET /api/cron/tier-serp-weekly
 *
 * Fetches a fresh SERP snapshot for every (Tier 1/2 product × keyword × market).
 * Iterates owners → products → keywords → markets. One DataForSEO call per
 * (keyword × market) pair. Idempotent within a single day via the
 * UNIQUE (owner, product, keyword, market, snapshot_date) constraint —
 * re-running on the same day just upserts.
 *
 * Schedule: every Monday 02:00 UTC via GitHub Actions cron (see
 * .github/workflows/tier-serp-weekly.yml).
 *
 * Auth: Bearer CRON_SECRET. Returns processed counts + per-owner breakdown.
 *
 * Cost: ~$0.0006 × N calls. For 35 products × 6 keywords × 5 markets × 2
 * brands = ~2,100 calls/run, ~$1.26/run, ~$5.50/month. See spec.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface ProductRow {
  id:            string
  owner_user_id: string
  site_slug:     string
  product_name:  string
  url:           string | null
  tier:          number
}

interface KeywordRow {
  id:              string
  product_tier_id: string
  keyword:         string
  is_main:         boolean
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().slice(0, 10)
  let totalCalls    = 0
  let totalInserted = 0
  let totalFailed   = 0
  const perOwner: Record<string, { products: number; keywords: number; calls: number }> = {}

  // ── 1. Pull every tier 1/2 product across all owners ─────────────────────
  const { data: products } = await db
    .from('product_tiers')
    .select('id, owner_user_id, site_slug, product_name, url, tier')
  const tierProducts = (products ?? []) as ProductRow[]

  if (tierProducts.length === 0) {
    return NextResponse.json({ ok: true, message: 'No tier products configured. Skipping.' })
  }

  // Group by owner so we can log per-owner stats
  const byOwner = new Map<string, ProductRow[]>()
  for (const p of tierProducts) {
    const arr = byOwner.get(p.owner_user_id) ?? []
    arr.push(p)
    byOwner.set(p.owner_user_id, arr)
  }

  // ── 2. For each owner, fetch keywords + iterate (kw × market) ─────────────
  for (const [ownerId, ownerProducts] of byOwner) {
    perOwner[ownerId] = { products: ownerProducts.length, keywords: 0, calls: 0 }

    // Pull keywords for all this owner's tier products in one query
    const productIds = ownerProducts.map(p => p.id)
    const { data: keywords } = await db
      .from('tier_keywords')
      .select('id, product_tier_id, keyword, is_main')
      .eq('owner_user_id', ownerId)
      .in('product_tier_id', productIds)

    const kwsByProduct: Record<string, KeywordRow[]> = {}
    for (const k of (keywords ?? []) as KeywordRow[]) {
      kwsByProduct[k.product_tier_id] ??= []
      kwsByProduct[k.product_tier_id].push(k)
    }
    perOwner[ownerId].keywords = (keywords ?? []).length

    // Iterate per product → keyword → market
    for (const product of ownerProducts) {
      const productKws = kwsByProduct[product.id] ?? []
      if (productKws.length === 0) continue   // skip un-keyworded products

      const ourDomains = ourDomainsForSite(product.site_slug)
      if (ourDomains.length === 0) {
        console.warn(`[tier-serp-weekly] unknown site_slug "${product.site_slug}", skipping product ${product.id}`)
        continue
      }

      for (const kw of productKws) {
        for (const market of TIER_MARKET_CODES) {
          totalCalls++
          perOwner[ownerId].calls++

          try {
            const result = await fetchSerpForMarket(kw.keyword, market as TierMarket, ourDomains, 50)

            const { error: upsertErr } = await db
              .from('tier_serp_snapshots')
              .upsert({
                owner_user_id:   ownerId,
                product_tier_id: product.id,
                tier_keyword_id: kw.id,
                keyword:         kw.keyword,
                market:          market,
                snapshot_date:   today,
                our_position:    result.ourPosition,
                our_url:         result.ourUrl,
                top_10:          result.top10,
                total_results:   result.totalResults,
                captured_at:     new Date().toISOString(),
              }, { onConflict: 'owner_user_id,product_tier_id,keyword,market,snapshot_date' })

            if (upsertErr) {
              totalFailed++
              console.error(`[tier-serp-weekly] upsert failed for "${kw.keyword}" @ ${market}:`, upsertErr.message)
            } else {
              totalInserted++
            }
          } catch (e) {
            totalFailed++
            console.error(`[tier-serp-weekly] fetch failed for "${kw.keyword}" @ ${market}:`, e)
          }
        }
      }
    }
  }

  // Log to api_usage_logs for the dashboard cost panel. Counted as one
  // dataforseo unit per call.
  if (totalCalls > 0) {
    await db.from('api_usage_logs').insert({
      api_name:    'dataforseo',
      endpoint:    'tier_serp_weekly',
      call_count:  totalCalls,
      metadata:    { products: tierProducts.length, owners: byOwner.size },
      created_at:  new Date().toISOString(),
    })
  }

  return NextResponse.json({
    ok:        true,
    snapshot_date: today,
    products:  tierProducts.length,
    calls:     totalCalls,
    inserted:  totalInserted,
    failed:    totalFailed,
    owners:    perOwner,
  })
}
