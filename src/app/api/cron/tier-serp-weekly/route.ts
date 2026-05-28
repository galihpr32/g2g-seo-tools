import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { fetchSerpForMarket, marketsForKeyword, ourDomainsForSite, type TierMarket } from '@/lib/ranking-tracker'

export const maxDuration = 300

/**
 * GET /api/cron/tier-serp-weekly
 *
 * Sprint SERP.CHUNKED rewrite — produces SERP snapshots for every
 * (Tier 1/2 product × keyword × market) tuple, with per-pair PARALLEL
 * fetching to fit in Vercel's 300s function ceiling.
 *
 * How:
 *   1. For each (owner × site_slug) with tier products, collect all
 *      (keyword × market) pairs into a queue.
 *   2. Process pairs in chunks of 25 in parallel — ~3-5s/chunk.
 *   3. Hard-stop at MAX_RUN_MS (270s, leaves 30s safety buffer); any
 *      pending pairs persist in serp_baseline_runs and pick up next run.
 *
 * Schedule: Monday 02:00 UTC via .github/workflows/tier-serp-weekly.yml.
 *
 * Auth: Bearer CRON_SECRET. Returns processed counts.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

const CHUNK_SIZE   = 25
const MAX_RUN_MS   = 270_000                  // 270s — 30s before Vercel 300s timeout
const PER_TICK_MS  = 55_000                   // each parallel batch wall-time budget

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
  language?:       string
}

interface PendingPair {
  product_id: string
  keyword_id: string
  keyword:    string
  market:     string
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today        = new Date().toISOString().slice(0, 10)
  const startTime    = Date.now()
  let totalProcessed = 0
  let totalFailed    = 0
  const perOwnerSite: Record<string, { processed: number; failed: number; remaining: number }> = {}

  // ── 1. Pull every tier 1/2 product across all owners ─────────────────────
  const { data: products } = await db
    .from('product_tiers')
    .select('id, owner_user_id, site_slug, product_name, url, tier')
  const tierProducts = (products ?? []) as ProductRow[]
  if (tierProducts.length === 0) {
    return NextResponse.json({ ok: true, message: 'No tier products configured. Skipping.' })
  }

  // Group by (owner × site_slug)
  const byOwnerSite = new Map<string, ProductRow[]>()
  for (const p of tierProducts) {
    const key = `${p.owner_user_id}|${p.site_slug}`
    const arr = byOwnerSite.get(key) ?? []
    arr.push(p)
    byOwnerSite.set(key, arr)
  }

  // ── 2. Process each (owner × site) group with chunked parallel calls ─────
  for (const [key, ownerSiteProducts] of byOwnerSite) {
    if (Date.now() - startTime > MAX_RUN_MS) break
    const [ownerId, siteSlug] = key.split('|')

    // Pull keywords for this owner × site's products
    const productIds = ownerSiteProducts.map(p => p.id)
    const { data: keywords } = await db
      .from('tier_keywords')
      .select('id, product_tier_id, keyword, language')
      .eq('owner_user_id', ownerId)
      .in('product_tier_id', productIds)

    const kwsByProduct: Record<string, KeywordRow[]> = {}
    for (const k of (keywords ?? []) as KeywordRow[]) {
      kwsByProduct[k.product_tier_id] ??= []
      kwsByProduct[k.product_tier_id].push(k)
    }

    const ourDomains = ourDomainsForSite(siteSlug)
    if (ourDomains.length === 0) {
      console.warn(`[tier-serp-weekly] unknown site_slug "${siteSlug}", skipping owner ${ownerId}`)
      continue
    }

    // Build the work queue for this group — Sprint MARKETS.PRUNE: filter
    // markets to match keyword language (EN-kw → US, ID-kw → ID only)
    const pairs: PendingPair[] = []
    for (const product of ownerSiteProducts) {
      const kws = kwsByProduct[product.id] ?? []
      for (const kw of kws) {
        const markets = marketsForKeyword(kw.language ?? 'en')
        for (const market of markets) {
          pairs.push({
            product_id: product.id,
            keyword_id: kw.id,
            keyword:    kw.keyword,
            market,
          })
        }
      }
    }

    perOwnerSite[key] = { processed: 0, failed: 0, remaining: pairs.length }

    // Process chunks in parallel
    let i = 0
    while (i < pairs.length) {
      if (Date.now() - startTime > MAX_RUN_MS) break
      const chunk = pairs.slice(i, i + CHUNK_SIZE)

      const tickStart = Date.now()
      const results = await Promise.allSettled(chunk.map(async p => {
        const result = await fetchSerpForMarket(p.keyword, p.market as TierMarket, ourDomains, 50)
        const { error: upsertErr } = await db
          .from('tier_serp_snapshots')
          .upsert({
            owner_user_id:   ownerId,
            product_tier_id: p.product_id,
            tier_keyword_id: p.keyword_id,
            keyword:         p.keyword,
            market:          p.market,
            snapshot_date:   today,
            our_position:    result.ourPosition,
            our_url:         result.ourUrl,
            top_10:          result.top10,
            total_results:   result.totalResults,
            captured_at:     new Date().toISOString(),
          }, { onConflict: 'owner_user_id,product_tier_id,keyword,market,snapshot_date' })
        if (upsertErr) throw new Error(`upsert: ${upsertErr.message}`)
        return true
      }))

      const ok   = results.filter(r => r.status === 'fulfilled').length
      const fail = results.filter(r => r.status === 'rejected').length
      perOwnerSite[key].processed += ok
      perOwnerSite[key].failed    += fail
      totalProcessed += ok
      totalFailed    += fail
      i += chunk.length
      perOwnerSite[key].remaining = pairs.length - i

      // Per-tick latency guard — if a chunk took longer than budget, stop
      // early to avoid blowing the 300s ceiling.
      if (Date.now() - tickStart > PER_TICK_MS && Date.now() - startTime > MAX_RUN_MS - 30_000) break
    }
  }

  if (totalProcessed > 0) {
    await db.from('api_usage_logs').insert({
      api_name:    'dataforseo',
      endpoint:    'tier_serp_weekly',
      call_count:  totalProcessed,
      metadata:    { products: tierProducts.length, groups: byOwnerSite.size },
      created_at:  new Date().toISOString(),
    })
  }

  const totalRemaining = Object.values(perOwnerSite).reduce((s, x) => s + x.remaining, 0)

  return NextResponse.json({
    ok:               true,
    snapshot_date:    today,
    products:         tierProducts.length,
    processed:        totalProcessed,
    failed:           totalFailed,
    remaining:        totalRemaining,
    duration_ms:      Date.now() - startTime,
    groups:           perOwnerSite,
    note:             totalRemaining > 0
      ? `${totalRemaining} pair(s) still pending — will be picked up by next cron run`
      : 'All pairs processed in this run',
  })
}
