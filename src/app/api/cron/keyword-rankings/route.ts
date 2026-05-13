import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { getSerpData } from '@/lib/dataforseo/client'
import { getCountryPreset } from '@/lib/country-config'

export const maxDuration = 300   // 5 min — DFS SERP calls are sequential to avoid rate limits

/**
 * GET /api/cron/keyword-rankings
 *
 * Daily SERP position check for every active tracked_product across all
 * active sites. For each (product, keyword) pair we hit DataForSEO's SERP
 * Live endpoint at the product's configured market country, scan the top-100
 * organic results, find any URL on the product's own domain, and persist a
 * keyword_ranking_history row for today.
 *
 * Auth: Bearer CRON_SECRET (called by GitHub Actions workflow).
 *
 * Idempotency: re-running the same day re-upserts the same composite key
 * (tracked_product_id, keyword, country_code, snapshot_date), so retries
 * are safe.
 *
 * Cost note: each keyword = 1 DFS SERP request (~$0.0006). 50 products ×
 * 5 keywords avg = 250 calls/day = ~$0.15/day = ~$5/month. Well within budget.
 *
 * Failure mode: per-keyword try/catch — one bad keyword doesn't kill the
 * whole run. Errors are logged in the response so the cron monitor (or a
 * human running ?dry=1) can see what's failing.
 */
function isCronAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

// Strip www./protocol for comparing organic_result.domain to our own domain
function normalizeHost(s: string): string {
  return String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
}

interface RankingRow {
  owner_user_id:      string
  site_slug:          string
  tracked_product_id: string
  keyword:            string
  country_code:       string
  snapshot_date:      string
  position:           number | null
  url:                string | null
  search_volume:      number | null
  serp_features:      Record<string, boolean | number> | null
  raw:                unknown
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    return NextResponse.json({ error: 'DataForSEO credentials not configured' }, { status: 500 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().split('T')[0]
  const stats = {
    sites_processed: 0,
    products_processed: 0,
    keywords_checked: 0,
    keywords_ranked: 0,
    rows_written: 0,
    errors: [] as { product: string; keyword: string; error: string }[],
  }

  // Fetch all active sites we should track. Mirrors the pattern other crons
  // use post Task #25 (multi-site iteration).
  const { data: sites, error: sitesErr } = await db
    .from('site_configs')
    .select('slug, favicon_domain')
    .eq('is_active', true)

  if (sitesErr || !sites || sites.length === 0) {
    return NextResponse.json({
      ok: false,
      error: sitesErr?.message ?? 'No active sites configured',
    }, { status: 500 })
  }

  const allRows: RankingRow[] = []

  // Checkpoint-upsert helper. Even with concurrency=8 the run can take a
  // few minutes on big workloads — if Vercel ever does kill us mid-loop, the
  // already-collected rows survive in the DB. Idempotent via the upsert
  // unique key (tracked_product_id, keyword, country_code, snapshot_date).
  async function flushPending(rows: RankingRow[]) {
    const CHUNK = 200
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      const { error } = await db
        .from('keyword_ranking_history')
        .upsert(chunk, {
          onConflict: 'tracked_product_id,keyword,country_code,snapshot_date',
          ignoreDuplicates: false,
        })
      if (error) {
        stats.errors.push({ product: '*', keyword: '*', error: `chunk upsert ${i}: ${error.message}` })
      } else {
        stats.rows_written += chunk.length
      }
    }
  }

  for (const site of sites) {
    stats.sites_processed++
    const siteSlug = String(site.slug)
    const ownDomain = normalizeHost(String(site.favicon_domain))

    // Pull all active products for this site
    const { data: products, error: prodErr } = await db
      .from('tracked_products')
      .select('id, owner_user_id, name, page_url, keywords, market')
      .eq('site_slug', siteSlug)
      .eq('active', true)

    if (prodErr) {
      stats.errors.push({ product: '*', keyword: '*', error: `[${siteSlug}] product fetch: ${prodErr.message}` })
      continue
    }
    if (!products || products.length === 0) continue

    for (const product of products) {
      stats.products_processed++
      const keywords = (product.keywords as string[] | null) ?? []
      if (keywords.length === 0) continue

      const market = String(product.market ?? 'us')
      const preset = getCountryPreset(market)

      // Parallelize DFS SERP calls in CONCURRENCY-sized batches. Pre-fix this
      // loop was sequential (~1.5s × keyword count) and 504-timed-out around
      // 150 keywords. With concurrency=8 the same workload completes in ~1/8
      // the wall time. DataForSEO's account-level rate limit is around 30
      // req/s for SERP Live, so 8 concurrent is well under threshold.
      const CONCURRENCY = 8
      for (let i = 0; i < keywords.length; i += CONCURRENCY) {
        const batch = keywords.slice(i, i + CONCURRENCY)
        const settled = await Promise.allSettled(
          batch.map(kw => getSerpData(kw, preset.dfsLocationCode, preset.dfsLanguageCode, 100)
            .then(serp => ({ keyword: kw, serp }))),
        )

        for (let j = 0; j < settled.length; j++) {
          const keyword = batch[j]
          stats.keywords_checked++
          const r = settled[j]
          if (r.status === 'rejected') {
            stats.errors.push({
              product: String(product.name),
              keyword,
              error:   r.reason instanceof Error ? r.reason.message : String(r.reason),
            })
            continue
          }
          const { serp } = r.value
          const ownResult = serp.organicResults.find(o => normalizeHost(o.domain) === ownDomain)
          const serpFeatures = {
            has_paa:             serp.peopleAlsoAsk.length > 0,
            has_related:         serp.relatedSearches.length > 0,
            organic_top10_count: serp.organicResults.filter(o => o.rank_absolute <= 10).length,
          }
          if (ownResult) stats.keywords_ranked++

          allRows.push({
            owner_user_id:      String(product.owner_user_id),
            site_slug:          siteSlug,
            tracked_product_id: String(product.id),
            keyword,
            country_code:       market.toLowerCase(),
            snapshot_date:      today,
            position:           ownResult?.rank_absolute ?? null,
            url:                ownResult?.url ?? null,
            search_volume:      null,                  // filled in by future Saga enrichment job, not blocking
            serp_features:      serpFeatures,
            raw:                ownResult ?? null,    // only the matching row, not 100 organic results (size)
          })
        }
      }
    }

    // Checkpoint: flush this site's rows so partial progress survives a
    // function timeout. Splice out what we just flushed so the next site
    // starts fresh on allRows.
    if (allRows.length > 0) {
      await flushPending(allRows.splice(0))
    }
  }

  // Final safety flush — should be a no-op if per-site flushes ran cleanly.
  if (allRows.length > 0) {
    await flushPending(allRows)
  }

  return NextResponse.json({
    ok:            stats.errors.length === 0,
    snapshot_date: today,
    stats,
  })
}
