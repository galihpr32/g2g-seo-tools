// ─── Tier 1/2 Keyword Ranking Tracker — DataForSEO helpers ────────────────────
// Wraps getSerpData() with market constants + result parsing for our specific
// product-ranking use case:
//   1. Pick one of our 5 tracked markets (US, DE, FR, MY, ID)
//   2. Fetch the top-N SERP for a keyword
//   3. Find our position (by matching G2G or OffGamers domain on result rows)
//   4. Return a compact structure ready to persist into tier_serp_snapshots
//
// Cost: one DataForSEO `/serp/google/organic/live/advanced` call per keyword
// per market per refresh. At ~$0.0006/call, ~12-15k calls/month gives ~$8/mo
// for a moderately-populated tier list across both brands.

import { getSerpData, type SerpOrganicResult } from '@/lib/dataforseo/client'

/** Markets we track. Universal across all Tier 1/2 products per Galih's spec.
 *  Each tuple is [locationCode, languageCode] for DataForSEO. Codes pulled
 *  from https://docs.dataforseo.com/v3/serp/google/locations/ — kept
 *  client-side so the alert cron + UI dropdown stay in sync. */
export const TIER_MARKETS = {
  us: { locationCode: 2840, languageCode: 'en', label: 'United States' },
  de: { locationCode: 2276, languageCode: 'de', label: 'Germany' },
  fr: { locationCode: 2250, languageCode: 'fr', label: 'France' },
  my: { locationCode: 2458, languageCode: 'en', label: 'Malaysia' },
  id: { locationCode: 2360, languageCode: 'id', label: 'Indonesia' },
} as const

export type TierMarket = keyof typeof TIER_MARKETS

// Sprint MARKETS.PRUNE — pause DE/FR/MY temporarily for budget. Default
// ACTIVE = US (Global) + ID. Override via env DATAFORSEO_ACTIVE_MARKETS=us,de,fr,my,id
// when budget allows re-enabling.
const ACTIVE_MARKETS_ENV = process.env.DATAFORSEO_ACTIVE_MARKETS ?? 'us,id'
export const TIER_MARKET_CODES: TierMarket[] = ACTIVE_MARKETS_ENV
  .split(',')
  .map(s => s.trim().toLowerCase() as TierMarket)
  .filter((m): m is TierMarket => m in TIER_MARKETS)

/** All markets we COULD track (universe) — used by UI dropdowns + tests. */
export const TIER_MARKET_CODES_ALL: TierMarket[] = ['us', 'de', 'fr', 'my', 'id']

/** Markets that should run for an EN-language keyword (Global proxy). */
export const EN_MARKETS: TierMarket[] = TIER_MARKET_CODES.filter(m => m !== 'id')

/** Markets that should run for an ID-language keyword. */
export const ID_MARKETS: TierMarket[] = TIER_MARKET_CODES.filter(m => m === 'id')

/** Pick markets to run for a keyword based on its language column. */
export function marketsForKeyword(language: 'en' | 'id' | string): TierMarket[] {
  if (language === 'id') return ID_MARKETS
  return EN_MARKETS
}

/** Top-10 row that we persist into tier_serp_snapshots.top_10. */
export interface SerpTopRow {
  position: number
  url:      string
  domain:   string
  title:    string
}

/** Result of a single SERP fetch — shape that maps 1:1 to one row in the
 *  tier_serp_snapshots table. `ourPosition` is null when we don't rank in
 *  the captured depth. */
export interface SerpFetchResult {
  market:        TierMarket
  keyword:       string
  ourPosition:   number | null
  ourUrl:        string | null
  top10:         SerpTopRow[]
  totalResults:  number
}

/**
 * Fetch the SERP for one keyword in one market and locate our domain's
 * highest-ranking result. depth=50 is enough to find the overwhelming
 * majority of legit positions while keeping the DataForSEO bill in check.
 *
 * `ourDomains` — list of all our-brand domains to count as "ours" (e.g.
 * ['g2g.com'] or both ['g2g.com', 'offgamers.com'] if we want shared visibility).
 * We match on lowercase domain suffix so subdomains (www.g2g.com, sg.g2g.com,
 * www.offgamers.com) all count.
 */
export async function fetchSerpForMarket(
  keyword:    string,
  market:     TierMarket,
  ourDomains: string[],
  depth:      number = 50,
): Promise<SerpFetchResult> {
  const cfg  = TIER_MARKETS[market]
  const data = await getSerpData(keyword, cfg.locationCode, cfg.languageCode, depth)

  const top10: SerpTopRow[] = data.organicResults
    .slice(0, 10)
    .map(r => ({
      position: r.rank_absolute,
      url:      r.url,
      domain:   r.domain,
      title:    r.title,
    }))

  // Find our highest-ranking result. We check ALL organic rows (not just top
  // 10) so deep positions still surface — useful for "we slipped to #28" alerts.
  let ourPosition: number | null = null
  let ourUrl:      string | null = null
  const matchOurs = (r: SerpOrganicResult) => {
    const d = (r.domain ?? '').toLowerCase()
    return ourDomains.some(own => d === own || d.endsWith('.' + own))
  }
  for (const r of data.organicResults) {
    if (matchOurs(r)) {
      ourPosition = r.rank_absolute
      ourUrl      = r.url
      break
    }
  }

  return {
    market,
    keyword,
    ourPosition,
    ourUrl,
    top10,
    totalResults: data.organicResults.length,
  }
}

/**
 * Sequential batch helper: fetch SERPs for many (keyword × market) pairs.
 *  - Sequential so we don't overload DataForSEO (their account-level rate
 *    limit kicks at ~1 req/100ms; sequential calls are well below that).
 *  - On failure of one pair, log + continue. Caller decides whether to skip
 *    or retry the failed row later.
 *
 * Returns one SerpFetchResult per attempted pair. Failed pairs get a result
 * with totalResults=0 + ourPosition=null so the caller can detect them.
 */
export async function fetchSerpBatch(
  pairs:      Array<{ keyword: string; market: TierMarket }>,
  ourDomains: string[],
): Promise<SerpFetchResult[]> {
  const out: SerpFetchResult[] = []
  for (const { keyword, market } of pairs) {
    try {
      out.push(await fetchSerpForMarket(keyword, market, ourDomains))
    } catch (e) {
      console.error(`[ranking-tracker] fetch failed for "${keyword}" @ ${market}:`, e)
      out.push({
        market, keyword,
        ourPosition: null, ourUrl: null,
        top10: [], totalResults: 0,
      })
    }
  }
  return out
}

// ─── Alert thresholds ────────────────────────────────────────────────────────

/** Tier 1 alert: drop ≥3 positions from previous snapshot. */
export const T1_DROP_THRESHOLD = 3

/** Tier 2 alert: fell out of top 10 (was ≤10, now >10 or null). */
export function isT2FallOutOfTop10(prev: number | null, curr: number | null): boolean {
  if (prev == null) return false
  if (prev > 10)    return false
  return curr == null || curr > 10
}

/** Tier 1 alert check — returns positive drop magnitude when alert-worthy. */
export function t1DropMagnitude(prev: number | null, curr: number | null): number {
  if (prev == null || curr == null) return 0
  const drop = curr - prev   // positive number means we slipped down (higher pos = worse)
  return drop >= T1_DROP_THRESHOLD ? drop : 0
}

// ─── Brand domain resolution ─────────────────────────────────────────────────

/** Convert a site_slug into the list of "our" domains to match SERP rows
 *  against. G2G has multiple regional subdomains; we count any of them as
 *  ours so a #4 result on sg.g2g.com still resolves to "we rank #4". */
export function ourDomainsForSite(siteSlug: string): string[] {
  if (siteSlug === 'g2g')        return ['g2g.com']
  if (siteSlug === 'offgamers')  return ['offgamers.com']
  return []
}
