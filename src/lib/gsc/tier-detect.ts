// Sprint GSC.T1.DOD — Tier-aware ranking drop detection.
//
// Why two strategies:
//   • Tier 1 pages move revenue daily. We want to KNOW within 24h if a
//     #1 ranking is slipping. A 10% click drop day-over-day is real signal.
//   • Tier 2 / non-tier pages have noisier daily traffic — DoD signal is
//     mostly noise. WoW with a 4-day lag (giving GSC's data 3-4 days to
//     stabilize) is the right SNR.
//
// 4-day lag rationale: Google Search Console "fresh" data is only ~70%
// complete in the first 1-3 days; by day 4 it's stable. Comparing day-4
// to day-5 (or week ending day-4 vs week ending day-11) gives us a
// stable signal that doesn't ping us for data-pipeline artefacts.
//
// Tier matching: substring/path match between GSC's reported page URL
// and product_tiers.url. We normalize both to path-only and lowercase
// to handle protocol/host variations between GSC entries and our DB.
//
// This file does the orchestration; date-fetching and window construction
// happen in the caller (gsc-daily cron) so tests can inject fixtures.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { RankingRow, RankingDrop } from './client'

// ── Thresholds (env-tunable) ────────────────────────────────────────────────
// Defaults reflect Galih's stated preference: T1 day-over-day ≥10%,
// others WoW ≥15%. Tighter T1 trigger = more alerts but caught faster.
const T1_DOD_THRESHOLD     = Number(process.env.GSC_T1_DOD_THRESHOLD     ?? '0.10')   // 10%
const OTHERS_WOW_THRESHOLD = Number(process.env.GSC_OTHERS_WOW_THRESHOLD ?? '0.15')   // 15%
const LAG_DAYS_DEFAULT     = Number(process.env.GSC_LAG_DAYS             ?? '4')      // GSC freshness lag

export interface TierPage {
  url:           string    // canonical product URL from product_tiers.url
  path:          string    // lowercased path portion of the URL, for matching
  tier:          1 | 2
  product_name:  string
  site_slug:     string
  restriction_type: string | null
}

/** Lag in days used for "current" window endpoint. Centralized for tests. */
export function getLagDays(): number {
  return LAG_DAYS_DEFAULT
}

/** Threshold the caller should display in Slack — surface as a single source of truth. */
export function getThresholds() {
  return {
    t1_dod_pct:     Math.round(T1_DOD_THRESHOLD * 100),
    others_wow_pct: Math.round(OTHERS_WOW_THRESHOLD * 100),
    lag_days:       LAG_DAYS_DEFAULT,
  }
}

/**
 * Load all T1 + T2 products for an owner × site that have a URL set.
 * Returns the normalized list — entries without URLs are dropped because
 * matching a GSC page row by relation_id is not possible (GSC never
 * surfaces relation_ids).
 */
export async function loadTierPagesForOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlug?: string,
): Promise<TierPage[]> {
  let q = db
    .from('product_tiers')
    .select('url, tier, product_name, site_slug, restriction_type')
    .eq('owner_user_id', ownerId)
    .not('url', 'is', null)
  if (siteSlug) q = q.eq('site_slug', siteSlug)

  const { data, error } = await q
  if (error || !data) return []

  const out: TierPage[] = []
  for (const r of data) {
    const url = String(r.url ?? '').trim()
    if (!url) continue
    const path = normalizePath(url)
    if (!path) continue
    out.push({
      url,
      path,
      tier:             r.tier === 2 ? 2 : 1,
      product_name:     String(r.product_name ?? ''),
      site_slug:        String(r.site_slug ?? ''),
      restriction_type: r.restriction_type ?? null,
    })
  }
  return out
}

/**
 * Reduce a URL (full or relative) to lowercased pathname with no trailing
 * slash. Handles malformed inputs by returning empty string.
 */
export function normalizePath(input: string): string {
  if (!input) return ''
  try {
    // If it already looks like a path (starts with /), use as-is
    if (input.startsWith('/')) {
      return stripTrailingSlash(input.toLowerCase())
    }
    const u = new URL(input)
    return stripTrailingSlash(u.pathname.toLowerCase())
  } catch {
    // Fallback: strip protocol+host manually
    const noProto = input.replace(/^https?:\/\/[^/]+/i, '')
    return stripTrailingSlash(noProto.toLowerCase())
  }
}

function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p
}

/**
 * Match a GSC page URL to its tier. Strict path-equality on the normalized
 * form — substring matching produces too many false positives (e.g.
 * /categories/genshin matching /categories/genshin-account).
 *
 * Returns null when no tier mapping exists; caller treats null as
 * "use the others (WoW) threshold".
 */
export function matchPageToTier(gscPage: string, tierMap: Map<string, TierPage>): TierPage | null {
  const norm = normalizePath(gscPage)
  if (!norm) return null
  return tierMap.get(norm) ?? null
}

/** Convenience: build the tier path index once per cron run. */
export function buildTierMap(pages: TierPage[]): Map<string, TierPage> {
  const m = new Map<string, TierPage>()
  for (const p of pages) {
    if (!m.has(p.path)) m.set(p.path, p)
  }
  return m
}

// ── Drop detection ───────────────────────────────────────────────────────────

export interface TieredDrop extends RankingDrop {
  /** 1 for T1, 2 for T2, null for non-tier matches */
  tier:           1 | 2 | null
  /** Which comparison fired this drop */
  comparison:     'day_over_day' | 'week_over_week'
  /** Which threshold fired (so the Slack alert can say "10% T1 trigger") */
  threshold_pct:  number
  /** Product name from product_tiers when matched, else null */
  product_name:   string | null
  /** Pass-through DMCA flag — helps the alert message explain expected drops */
  restriction_type: string | null
}

/**
 * Apply tier-aware thresholds to two time windows.
 *
 * @param dod   — pair of (current_day, previous_day) rows for T1 day-over-day check.
 *                Pass empty arrays to skip T1 DoD detection entirely.
 * @param wow   — pair of (current_week, previous_week) rows for others WoW check.
 * @param tierMap — index from buildTierMap()
 */
export function detectTieredDrops(
  dod:     { current: RankingRow[]; previous: RankingRow[] },
  wow:     { current: RankingRow[]; previous: RankingRow[] },
  tierMap: Map<string, TierPage>,
): TieredDrop[] {
  const out: TieredDrop[] = []
  const seen = new Set<string>()   // dedupe by page — DoD fires first, WoW won't double-add

  // ── Tier 1 day-over-day pass ──────────────────────────────────────────────
  const dodPrev = new Map(dod.previous.map(r => [r.page, r]))
  for (const cur of dod.current) {
    const match = matchPageToTier(cur.page, tierMap)
    if (!match || match.tier !== 1) continue   // T1 only
    const prev = dodPrev.get(cur.page)
    if (!prev) continue

    const drop = computeDrop(cur, prev, T1_DOD_THRESHOLD)
    if (drop) {
      out.push({
        ...drop,
        tier:             1,
        comparison:       'day_over_day',
        threshold_pct:    Math.round(T1_DOD_THRESHOLD * 100),
        product_name:     match.product_name,
        restriction_type: match.restriction_type,
      })
      seen.add(cur.page)
    }
  }

  // ── Others week-over-week pass (T2 + non-tier) ────────────────────────────
  const wowPrev = new Map(wow.previous.map(r => [r.page, r]))
  for (const cur of wow.current) {
    if (seen.has(cur.page)) continue          // already alerted under T1 DoD
    const match = matchPageToTier(cur.page, tierMap)
    // Skip T1 here — they've already been evaluated under stricter DoD threshold
    if (match?.tier === 1) continue
    const prev = wowPrev.get(cur.page)
    if (!prev) continue

    const drop = computeDrop(cur, prev, OTHERS_WOW_THRESHOLD)
    if (drop) {
      out.push({
        ...drop,
        tier:             match?.tier ?? null,
        comparison:       'week_over_week',
        threshold_pct:    Math.round(OTHERS_WOW_THRESHOLD * 100),
        product_name:     match?.product_name ?? null,
        restriction_type: match?.restriction_type ?? null,
      })
    }
  }

  // Sort: T1 first (most urgent), then by clicks-drop descending within each tier.
  out.sort((a, b) => {
    const tierA = a.tier ?? 99
    const tierB = b.tier ?? 99
    if (tierA !== tierB) return tierA - tierB
    return b.clicksDrop - a.clicksDrop
  })

  return out
}

/**
 * Pure helper — given two rows, decide if it's a drop above threshold and
 * return the standard RankingDrop shape. Mirrors detectRankingDrops()
 * logic for consistency.
 */
function computeDrop(
  cur:       RankingRow,
  prev:      RankingRow,
  threshold: number,
): RankingDrop | null {
  const clicksDrop      = prev.clicks      > 0 ? (prev.clicks      - cur.clicks)      / prev.clicks      : 0
  const impressionsDrop = prev.impressions > 0 ? (prev.impressions - cur.impressions) / prev.impressions : 0
  const positionChange  = cur.position - prev.position

  if (clicksDrop < threshold && impressionsDrop < threshold && positionChange < 5) {
    return null
  }
  return {
    page:                cur.page,
    clicksDrop,
    impressionsDrop,
    positionChange,
    currentClicks:       cur.clicks,
    previousClicks:      prev.clicks,
    currentImpressions:  cur.impressions,
    previousImpressions: prev.impressions,
    currentPosition:     cur.position,
    previousPosition:    prev.position,
  }
}
