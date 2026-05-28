// ── Brand name resolver (Sprint CLUSTER.RENAME.1) ───────────────────────────
//
// Single source of truth for "what should the brand cluster be called?".
// Replaces the broken first-word-only logic from add_saga_cluster_hierarchy.sql
// (which gave us "Counter" instead of "CSGO", "World" instead of "WoW", etc.)
//
// Fallback order:
//   1. tier.brand_canonical       — explicit user override (best)
//   2. catalogRow.service_name    — canonical BDT catalog name (good)
//   3. tier.product_name          — raw product name, full not split (acceptable)
//
// Used by:
//   • /api/clusters/re-seed         (rename existing clusters in-place)
//   • Saga cluster-builder.ts       (when persisting new brand cluster topics)
//   • Tier admin form               (placeholder for the override field)

import type { SupabaseClient } from '@supabase/supabase-js'

export interface BrandResolveInputTier {
  id:               string
  product_name:     string
  brand_canonical?: string | null
  relation_id?:     string | null
}

export interface BrandResolveInputCatalog {
  service_name?: string | null
}

/**
 * Resolve the canonical brand name for a product tier.
 *
 * @param tier         — product_tiers row (must have product_name)
 * @param catalogRow   — optional g2g_products row matched via relation_id
 * @returns the canonical brand name, never empty (falls back to '(untitled)' as last resort)
 */
export function resolveBrandName(
  tier:       BrandResolveInputTier,
  catalogRow: BrandResolveInputCatalog | null | undefined,
): string {
  const explicit = (tier.brand_canonical ?? '').trim()
  if (explicit) return explicit

  const fromCatalog = (catalogRow?.service_name ?? '').trim()
  if (fromCatalog) return fromCatalog

  const raw = (tier.product_name ?? '').trim()
  if (raw) return raw

  return '(untitled)'
}

/**
 * Bulk resolver: load all tier products + their catalog match in one shot.
 * Returns a Map<tier.id, { resolved, source }> for callers that need to walk
 * many tiers at once (e.g. the re-seed migration script).
 *
 * `source` is purely for diagnostics — tells you which fallback level fired:
 *   • 'override' = brand_canonical was set
 *   • 'catalog'  = pulled from g2g_products.service_name
 *   • 'name'     = fell through to product_tiers.product_name
 */
export async function resolveBrandNamesBulk(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<Map<string, { resolved: string; source: 'override' | 'catalog' | 'name' }>> {
  const out = new Map<string, { resolved: string; source: 'override' | 'catalog' | 'name' }>()

  const { data: tiers } = await db
    .from('product_tiers')
    .select('id, product_name, brand_canonical, relation_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  const tierRows = (tiers ?? []) as Array<BrandResolveInputTier & { relation_id: string | null }>
  if (tierRows.length === 0) return out

  // Batch catalog lookup by relation_id
  const relIds = tierRows.map(t => t.relation_id).filter(Boolean) as string[]
  const catalogByRel = new Map<string, BrandResolveInputCatalog>()
  if (relIds.length > 0) {
    const { data: catalog } = await db
      .from('g2g_products')
      .select('relation_id, service_name')
      .in('relation_id', relIds)
    for (const row of (catalog ?? []) as Array<{ relation_id: string; service_name: string }>) {
      catalogByRel.set(row.relation_id, { service_name: row.service_name })
    }
  }

  for (const tier of tierRows) {
    const catalogRow = tier.relation_id ? catalogByRel.get(tier.relation_id) ?? null : null
    const explicit  = (tier.brand_canonical ?? '').trim()
    const fromCat   = (catalogRow?.service_name ?? '').trim()
    const fromName  = (tier.product_name ?? '').trim()
    if (explicit)  out.set(tier.id, { resolved: explicit, source: 'override' })
    else if (fromCat) out.set(tier.id, { resolved: fromCat,  source: 'catalog'  })
    else             out.set(tier.id, { resolved: fromName || '(untitled)', source: 'name' })
  }
  return out
}

/**
 * Slugify a brand name into a URL-safe slug. Mirrors the slugify in
 * lib/agents/site-helpers.ts (kept here to avoid cross-pkg import).
 */
export function brandSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
}
