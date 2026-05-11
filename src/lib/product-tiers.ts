// ─── Product Tier resolver ────────────────────────────────────────────────────
// Maps a product (identified by relation_id / URL / name) to its assigned tier
// (1, 2, or null). Used by Heimdall/Bragi/Tyr/Product Content/etc. to decide
// per-tier behavior (priority alerts, deeper prompts, hybrid-review gates).
//
// Lookup priority — first non-empty match wins:
//   1. relation_id  exact
//   2. url          exact
//   3. url          slug-suffix (last path segment)
//   4. product_name case-insensitive exact
//   5. product_name case-insensitive substring (loose fallback)
//
// For pages that need to tag many products at once (Pipeline, Briefs, Action
// Items), prefer loadTierMap() once + resolveTierFromMap() per row to avoid
// N round trips.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ProductTier {
  id:            string
  owner_user_id: string
  site_slug:     string
  tier:          1 | 2
  product_name:  string
  relation_id:   string | null
  url:           string | null
  notes:         string | null
  created_at:    string
  updated_at:    string
}

export interface TierMatch {
  relationId?:  string | null
  url?:         string | null
  productName?: string | null
}

// ─── Single-product lookup ────────────────────────────────────────────────────

/**
 * Resolve a product's tier with a single DB round-trip.
 * Use only for one-off lookups — for bulk page rendering use loadTierMap().
 */
export async function getProductTier(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>,
  ownerId:   string,
  siteSlug:  string,
  match:     TierMatch,
): Promise<{ tier: 1 | 2 | null; record: ProductTier | null }> {
  // Pull the (small) tier list for this owner+site once and resolve client-side.
  // Even at the upper bound (10 + 25 = 35 rows per brand) this stays cheap and
  // avoids 3-5 separate keyed lookups.
  const map = await loadTierMap(db, ownerId, siteSlug)
  return resolveTierFromMap(map, match)
}

// ─── Bulk lookup (preferred for pages) ───────────────────────────────────────

export interface TierMap {
  byRelationId: Map<string, ProductTier>   // exact key
  byUrl:        Map<string, ProductTier>   // exact key (lowercased)
  bySlug:       Map<string, ProductTier>   // last path segment of url (lowercased)
  byName:       Map<string, ProductTier>   // lowercased product_name
  all:          ProductTier[]              // raw list (for other UI uses)
}

const EMPTY_MAP: TierMap = {
  byRelationId: new Map(),
  byUrl:        new Map(),
  bySlug:       new Map(),
  byName:       new Map(),
  all:          [],
}

/**
 * Load all Tier 1+2 entries for the given owner+brand and build resolver maps.
 * Server-side only — for client pages, fetch /api/product-tiers and pass the
 * `items` array to buildTierMap() instead.
 */
export async function loadTierMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>,
  ownerId:   string,
  siteSlug:  string,
): Promise<TierMap> {
  const { data, error } = await db
    .from('product_tiers')
    .select('id, owner_user_id, site_slug, tier, product_name, relation_id, url, notes, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (error || !data) return EMPTY_MAP
  return buildTierMap(data as ProductTier[])
}

/**
 * Pure builder — takes a list of ProductTier rows (e.g. from the JSON API
 * response) and constructs a TierMap. Client-safe (no DB dependency).
 */
export function buildTierMap(rows: ProductTier[]): TierMap {
  const map: TierMap = {
    byRelationId: new Map(),
    byUrl:        new Map(),
    bySlug:       new Map(),
    byName:       new Map(),
    all:          rows,
  }

  for (const r of rows) {
    if (r.relation_id) map.byRelationId.set(r.relation_id, r)
    if (r.url) {
      const u = r.url.trim().toLowerCase()
      map.byUrl.set(u, r)
      const slug = extractSlug(u)
      if (slug) map.bySlug.set(slug, r)
    }
    if (r.product_name) map.byName.set(r.product_name.trim().toLowerCase(), r)
  }
  return map
}

/**
 * Synchronous resolver against a pre-loaded TierMap. Returns the tier record
 * if any of the match keys hits, else null. Called per-row inside page loops.
 */
export function resolveTierFromMap(
  map:   TierMap,
  match: TierMatch,
): { tier: 1 | 2 | null; record: ProductTier | null } {
  // 1. relation_id exact
  if (match.relationId) {
    const hit = map.byRelationId.get(match.relationId)
    if (hit) return { tier: hit.tier, record: hit }
  }

  // 2. url exact (lowercased)
  if (match.url) {
    const u = match.url.trim().toLowerCase()
    const hit = map.byUrl.get(u)
    if (hit) return { tier: hit.tier, record: hit }

    // 3. url slug suffix — handles small variations in domain/protocol/query
    const slug = extractSlug(u)
    if (slug) {
      const hitBySlug = map.bySlug.get(slug)
      if (hitBySlug) return { tier: hitBySlug.tier, record: hitBySlug }
    }
  }

  // 4. product_name exact (case-insensitive)
  if (match.productName) {
    const n = match.productName.trim().toLowerCase()
    const hit = map.byName.get(n)
    if (hit) return { tier: hit.tier, record: hit }

    // 5. substring loose fallback — Tier list "Albion Online" matches opp
    //    "Albion Online Global Account". Last resort because it's noisy.
    for (const [key, rec] of map.byName) {
      if (n.includes(key) || key.includes(n)) {
        return { tier: rec.tier, record: rec }
      }
    }
  }

  return { tier: null, record: null }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pull the last path segment from a URL — that's the part that uniquely
 * identifies a product page, ignoring domain / category prefix differences.
 *
 * https://www.g2g.com/categories/albion-online-global-account?ref=foo
 *   → "albion-online-global-account"
 */
function extractSlug(url: string): string | null {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1].toLowerCase() : null
  } catch {
    // Not a parseable URL — fall back to last "/segment" of raw string
    const parts = url.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1].toLowerCase() : null
  }
}

/**
 * Convenience for code that just wants a 1/2/null number without unpacking.
 */
export function tierOf(
  map:   TierMap,
  match: TierMatch,
): 1 | 2 | null {
  return resolveTierFromMap(map, match).tier
}

/**
 * Sort comparator — Tier 1 above Tier 2 above untiered. For UI lists.
 */
export function tierSortKey(t: 1 | 2 | null): number {
  if (t === 1) return 0
  if (t === 2) return 1
  return 2
}
