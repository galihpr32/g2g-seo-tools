// ─── Hugin aggregator ───────────────────────────────────────────────────────
//
// Reads gsc_query_snapshots across 4 time windows (7d/30d/60d/90d) and
// computes per-query Hugin discovery rows. Applied filters:
//   • classifyQuery() — word count OR phrase pattern, excluding brand
//   • min_impressions threshold (default 30 per window)
//
// Computes per (query × period):
//   • total impressions/clicks (current window)
//   • prior-period impressions/clicks (same-length window ending right before)
//   • growth_pct = (current - prior) / prior * 100 (NULL if prior=0)
//   • is_new    = prior_impressions = 0
//   • position_delta (positive = climbing in rank)
//   • CTR rising signal
//   • top_page (most-impressed) + top_market (derived from page URL pattern)
//   • dmca_flag (top_page has DMCA restriction)
//   • auto_matched_product (fuzzy match against product_tiers)
//
// Upserts into hugin_queries. Preserves user-set status (claimed/covered/ignored).

import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyQuery, buildProductStopList, wordCount } from './classify'

// Sprint HEIMDALL.LAG.FIX — apply 4-day GSC freshness lag
const GSC_LAG_DAYS    = 4
const WINDOW_DAYS     = [7, 30, 60, 90] as const
const MIN_IMPRESSIONS = 30
const MIN_WORDS       = 4

export interface AggregatorResult {
  owner_user_id:    string
  site_slug:        string
  per_window: Array<{
    period_days:    number
    qualified:      number
    upserted:       number
    skipped_brand:  number
    skipped_short:  number
    skipped_lowimp: number
  }>
  total_upserted:   number
  duration_ms:      number
  error?:           string
}

export interface AggregatorInput {
  ownerId:    string
  siteSlug:   string
  /** GSC property URL, e.g. "https://www.g2g.com/" or "sc-domain:g2g.com" */
  gscPropertyUrl: string
}

// ─── Date helpers ───────────────────────────────────────────────────────────

function dateAddDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * For window of length N days, returns:
 *   current  = [end-N+1 .. end]
 *   prior    = [end-2N+1 .. end-N]
 * end is "today minus GSC_LAG_DAYS".
 */
function computeWindows(periodDays: number) {
  const today  = new Date()
  const end    = dateAddDays(today, -GSC_LAG_DAYS)
  const curStart   = dateAddDays(end, -periodDays + 1)
  const priorEnd   = dateAddDays(curStart, -1)
  const priorStart = dateAddDays(priorEnd, -periodDays + 1)
  return {
    cur:   { start: toIsoDate(curStart),   end: toIsoDate(end) },
    prior: { start: toIsoDate(priorStart), end: toIsoDate(priorEnd) },
  }
}

// ─── Per-period aggregator ──────────────────────────────────────────────────

interface AggregatedRow {
  query:                string
  total_impressions:    number
  total_clicks:         number
  position_sum_weighted: number   // sum(position × impressions) for weighted avg
  ctr_sum_weighted:     number    // sum(ctr × impressions) for weighted avg
  imp_for_avg:          number    // denominator (excludes 0-imp rows)
  top_page:             string | null
  top_page_imp:         number
}

interface PriorRow {
  total_impressions: number
  total_clicks:      number
  position_sum_weighted: number
  ctr_sum_weighted:  number
  imp_for_avg:       number
}

/**
 * Pull gsc_query_snapshots for given date range and aggregate per query.
 * Returns Map<queryLower, aggregated>.
 */
async function pullAndAggregate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  siteUrl:  string,
  start:    string,
  end:      string,
): Promise<Map<string, AggregatedRow>> {
  const byQuery = new Map<string, AggregatedRow>()

  // Page through results. GSC daily can have 2k rows × 90 days = 180k for big sites.
  // Supabase default cap is 1000 per query; we page until exhausted.
  const PAGE = 1000
  let from = 0
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await db
      .from('gsc_query_snapshots')
      .select('query, clicks, impressions, ctr, position, page')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', start)
      .lte('snapshot_date', end)
      .range(from, from + PAGE - 1)

    if (error) throw new Error(`gsc_query_snapshots query: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data) {
      const q = String(row.query ?? '').toLowerCase().trim()
      if (!q) continue
      const imp = Number(row.impressions ?? 0)
      const cli = Number(row.clicks ?? 0)
      const pos = Number(row.position ?? 0)
      const ctr = Number(row.ctr ?? 0)

      let agg = byQuery.get(q)
      if (!agg) {
        agg = {
          query:                 q,
          total_impressions:     0,
          total_clicks:          0,
          position_sum_weighted: 0,
          ctr_sum_weighted:      0,
          imp_for_avg:           0,
          top_page:              null,
          top_page_imp:          0,
        }
        byQuery.set(q, agg)
      }
      agg.total_impressions += imp
      agg.total_clicks      += cli
      if (imp > 0) {
        agg.position_sum_weighted += pos * imp
        agg.ctr_sum_weighted      += ctr * imp
        agg.imp_for_avg           += imp
      }
      if (imp > agg.top_page_imp && row.page) {
        agg.top_page     = String(row.page)
        agg.top_page_imp = imp
      }
    }

    if (data.length < PAGE) break
    from += PAGE
  }

  return byQuery
}

function asPriorMap(byQuery: Map<string, AggregatedRow>): Map<string, PriorRow> {
  const out = new Map<string, PriorRow>()
  for (const [q, a] of byQuery.entries()) {
    out.set(q, {
      total_impressions:     a.total_impressions,
      total_clicks:          a.total_clicks,
      position_sum_weighted: a.position_sum_weighted,
      ctr_sum_weighted:      a.ctr_sum_weighted,
      imp_for_avg:           a.imp_for_avg,
    })
  }
  return out
}

// ─── Auto-match against product_tiers ───────────────────────────────────────

interface MatchableProduct { id: string; product_name: string; product_lower: string }

async function loadMatchableProducts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<MatchableProduct[]> {
  const { data } = await db
    .from('product_tiers')
    .select('id, product_name')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
  return (data ?? [])
    .map(p => ({
      id:            p.id as string,
      product_name:  p.product_name as string,
      product_lower: String(p.product_name).toLowerCase(),
    }))
    .sort((a, b) => b.product_lower.length - a.product_lower.length)
}

/** Simple longest-substring auto-match. Query must contain full product name. */
function autoMatchProduct(query: string, products: MatchableProduct[]): MatchableProduct | null {
  const q = query.toLowerCase()
  for (const p of products) {
    if (!p.product_lower) continue
    if (q.includes(p.product_lower)) return p
  }
  return null
}

// ─── DMCA flag helper ───────────────────────────────────────────────────────

async function buildDmcaPageSet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<Set<string>> {
  const set = new Set<string>()
  try {
    const { data } = await db
      .from('product_tiers')
      .select('url, restriction_type')
      .eq('owner_user_id', ownerId)
      .eq('site_slug',     siteSlug)
      .not('restriction_type', 'is', null)
    for (const row of (data ?? [])) {
      if (row.url && row.restriction_type) set.add(String(row.url).toLowerCase())
    }
  } catch {
    // restriction_type column may not exist on older deploys — non-fatal
  }
  return set
}

// ─── Market detection from page URL ─────────────────────────────────────────

function detectMarketFromPage(pageUrl: string | null): string | null {
  if (!pageUrl) return null
  const u = pageUrl.toLowerCase()
  if (u.includes('/id/') || u.includes('lang=id') || u.endsWith('/id'))   return 'id'
  if (u.includes('/us/') || u.includes('lang=us'))                         return 'us'
  return null   // default unknown — assume global
}

// ─── Main aggregator ────────────────────────────────────────────────────────

export async function runHuginAggregator(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:    SupabaseClient<any, any, any>,
  input: AggregatorInput,
): Promise<AggregatorResult> {
  const start = Date.now()
  const result: AggregatorResult = {
    owner_user_id:  input.ownerId,
    site_slug:      input.siteSlug,
    per_window:     [],
    total_upserted: 0,
    duration_ms:    0,
  }

  try {
    const productStopList = await buildProductStopList(db, input.ownerId, input.siteSlug)
    const products        = await loadMatchableProducts(db, input.ownerId, input.siteSlug)
    const dmcaPages       = await buildDmcaPageSet(db, input.ownerId, input.siteSlug)
    const nowIso          = new Date().toISOString()

    for (const periodDays of WINDOW_DAYS) {
      const { cur, prior } = computeWindows(periodDays)

      // eslint-disable-next-line no-await-in-loop
      const currentByQuery = await pullAndAggregate(db, input.gscPropertyUrl, cur.start,   cur.end)
      // eslint-disable-next-line no-await-in-loop
      const priorByQueryAgg = await pullAndAggregate(db, input.gscPropertyUrl, prior.start, prior.end)
      const priorByQuery   = asPriorMap(priorByQueryAgg)

      let qualified      = 0
      let upserted       = 0
      let skippedBrand   = 0
      let skippedShort   = 0
      let skippedLowImp  = 0

      const toInsert: Array<Record<string, unknown>> = []

      for (const [q, agg] of currentByQuery.entries()) {
        // Min-impressions guard (per window)
        if (agg.total_impressions < MIN_IMPRESSIONS) { skippedLowImp++; continue }

        const cls = classifyQuery(q, {
          minWords:              MIN_WORDS,
          includePhrasePatterns: true,
          productStopList,
        })
        if (cls.is_brand_query) { skippedBrand++; continue }
        if (!cls.qualifies)     { skippedShort++; continue }

        qualified++

        const prior = priorByQuery.get(q)
        const priorImp = prior?.total_impressions ?? 0
        const isNew    = priorImp === 0
        const growthPct = priorImp > 0
          ? Math.round(((agg.total_impressions - priorImp) / priorImp) * 10000) / 100  // 2 decimals
          : null

        const positionCurrent = agg.imp_for_avg > 0 ? agg.position_sum_weighted / agg.imp_for_avg : null
        const positionPrior   = prior && prior.imp_for_avg > 0 ? prior.position_sum_weighted / prior.imp_for_avg : null
        const positionDelta   = (positionPrior != null && positionCurrent != null)
          ? Math.round((positionPrior - positionCurrent) * 1000) / 1000
          : null

        const ctrCurrent = agg.imp_for_avg > 0 ? agg.ctr_sum_weighted / agg.imp_for_avg : null
        const ctrPrior   = prior && prior.imp_for_avg > 0 ? prior.ctr_sum_weighted / prior.imp_for_avg : null

        const topMarket  = detectMarketFromPage(agg.top_page)
        const dmcaFlag   = agg.top_page ? dmcaPages.has(String(agg.top_page).toLowerCase()) : false
        const matched    = autoMatchProduct(q, products)

        toInsert.push({
          owner_user_id:            input.ownerId,
          site_slug:                input.siteSlug,
          query:                    q,
          query_display:            q,
          word_count:               wordCount(q),
          period_days:              periodDays,
          total_impressions:        agg.total_impressions,
          total_clicks:             agg.total_clicks,
          ctr_current:              ctrCurrent,
          position_avg:             positionCurrent,
          prior_impressions:        priorImp,
          prior_clicks:             prior?.total_clicks ?? 0,
          ctr_prior:                ctrPrior,
          position_prior:           positionPrior,
          growth_pct:               growthPct,
          position_delta:           positionDelta,
          is_new:                   isNew,
          top_page:                 agg.top_page,
          top_market:               topMarket,
          dmca_flag:                dmcaFlag,
          phrase_pattern_match:     cls.matched_by_phrase_pattern,
          auto_matched_product_id:  matched?.id ?? null,
          auto_matched_product_name: matched?.product_name ?? null,
          last_aggregated_at:       nowIso,
          updated_at:               nowIso,
        })
      }

      // Upsert in batches. We use onConflict so user-set status/claimed_at
      // fields are preserved (we don't write those keys in the insert payload).
      if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += 500) {
          // eslint-disable-next-line no-await-in-loop
          const { error } = await db
            .from('hugin_queries')
            .upsert(toInsert.slice(i, i + 500), {
              onConflict:       'owner_user_id,site_slug,query,period_days',
              ignoreDuplicates: false,
            })
          if (error) {
            console.warn(`[hugin-aggregate] upsert error (period ${periodDays}d): ${error.message}`)
          } else {
            upserted += Math.min(500, toInsert.length - i)
          }
        }
      }

      result.per_window.push({
        period_days:    periodDays,
        qualified,
        upserted,
        skipped_brand:  skippedBrand,
        skipped_short:  skippedShort,
        skipped_lowimp: skippedLowImp,
      })
      result.total_upserted += upserted
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  result.duration_ms = Date.now() - start
  return result
}
