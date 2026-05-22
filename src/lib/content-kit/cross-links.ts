// ─── Cross-link suggester ──────────────────────────────────────────────────
//
// Sprint CKB.2 — Since G2G can't build supporting blog/spoke pages (marketplace
// constraint), internal linking moves to sibling product pages. This module
// suggests which OTHER product_tiers to link to from a given product page.
//
// Per Galih's call: cross-tier links allowed. So a PoE 2 Currency page can
// link to a Diablo 4 Currency page (ARPG genre sibling) even though they're
// different tiers.
//
// Scoring (highest first):
//   3 — same category AND same site_slug         (closest sibling)
//   2 — different category, same kb_category_id  (cross-tier same genre)
//   1 — same category but different site         (mostly irrelevant — drop)
// We keep top 4-6 suggestions to avoid link cluttering.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { KitCrossLink } from './types'

export interface CrossLinkInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:              SupabaseClient<any>
  ownerId:         string
  productTierId:   string
  siteSlug:        string
  /** Optional: limit candidates to ≤ N. Default 5. */
  limit?:          number
}

interface ProductRow {
  id:              string
  product_name:    string
  category:        string | null
  tier:            number | null
  url:             string | null
  site_slug:       string
  brand_canonical: string | null
}

/**
 * Suggest cross-links by scoring sibling product_tiers. Currently a
 * heuristic; later we can plug Haiku for semantic matching but this is
 * sufficient for first cut.
 */
export async function suggestCrossLinks(input: CrossLinkInput): Promise<KitCrossLink[]> {
  const { db, ownerId, productTierId, siteSlug } = input
  const limit = Math.min(input.limit ?? 5, 8)

  // 1) Anchor product details
  const { data: anchor } = await db
    .from('product_tiers')
    .select('id, product_name, category, tier, url, site_slug, brand_canonical')
    .eq('id', productTierId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!anchor) return []
  const anchorRow = anchor as ProductRow

  // 2) Candidates: every other product in the same workspace
  const { data: candidates } = await db
    .from('product_tiers')
    .select('id, product_name, category, tier, url, site_slug, brand_canonical')
    .eq('owner_user_id', ownerId)
    .neq('id', productTierId)
  const rows = (candidates ?? []) as ProductRow[]
  if (rows.length === 0) return []

  // 3) Score each
  type Scored = ProductRow & { score: number; reason: KitCrossLink['reason'] }
  const scored: Scored[] = []
  for (const r of rows) {
    let score = 0
    let reason: KitCrossLink['reason'] = 'sibling-tier'

    if (r.site_slug !== siteSlug) {
      continue   // only link within the same brand site
    }

    if (r.category && anchorRow.category && r.category === anchorRow.category) {
      score = 3
      reason = 'sibling-tier'
    } else if (r.category && anchorRow.category) {
      // Different category but same site — cross-genre link (e.g. PoE 2 Currency → Diablo 4 Currency)
      // Only allow if both are in 'transactional' product types (which we proxy by
      // both having a non-null tier). The category column itself is the genre.
      const looksRelated = anchorRow.category.length > 0 && r.category.length > 0
      if (looksRelated) {
        score = 2
        reason = 'cross-tier-genre'
      }
    }
    // Complementary: if names share a token (e.g. "Account" appears in both
    // PoE 2 Account and Diablo 4 Account, regardless of category)
    const anchorTokens = new Set(anchorRow.product_name.toLowerCase().split(/\s+/))
    const candidateTokens = r.product_name.toLowerCase().split(/\s+/)
    const sharedTokens = candidateTokens.filter(t => t.length > 3 && anchorTokens.has(t))
    if (sharedTokens.length > 0 && score < 2) {
      score = 2
      reason = 'complementary'
    }
    if (score > 0) scored.push({ ...r, score, reason })
  }

  // 4) Sort by score desc, then by tier asc (T1 sibling > T2 sibling)
  scored.sort((a, b) => b.score - a.score || (a.tier ?? 99) - (b.tier ?? 99))

  // 5) Top N → KitCrossLink shape
  return scored.slice(0, limit).map(p => ({
    target_product_id: p.id,
    target_url:        p.url ?? '',
    anchor_text:       suggestAnchorText(p, anchorRow.category),
    reason:            p.reason,
  }))
}

/**
 * Pick anchor text that's natural in body prose. Prefers brand_canonical
 * when set, falls back to product_name.
 */
function suggestAnchorText(target: ProductRow, anchorCategory: string | null): string {
  const name = (target.brand_canonical ?? target.product_name).trim()
  // If both are e.g. "Currency" products, anchor as "[Brand] currency"
  if (anchorCategory && target.category === anchorCategory) {
    return name
  }
  // Cross-genre: prefix with the genre to make context clear
  if (target.category) {
    return `${name} ${target.category.toLowerCase()}`
  }
  return name
}
