import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { mapToKbCanonical, type KbCategory } from '@/lib/category-mapping'

export const maxDuration = 30

/**
 * POST /api/product-tiers/bulk-from-catalog
 *
 * Body:
 *   {
 *     tier:         1 | 2,
 *     relation_ids: string[]    // up to ~100; values must exist in g2g_products
 *   }
 *
 * Auto-hydrates product_name + category + url from the catalog so the user
 * doesn't have to type them. Existing entries with the same relation_id get
 * tier upgraded/downgraded (upsert behaviour).
 *
 * Returns: { inserted, updated, skipped: [{relation_id, reason}] }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as { tier?: number; relation_ids?: string[] }
  const tier = body.tier === 1 ? 1 : body.tier === 2 ? 2 : null
  const relationIds = Array.isArray(body.relation_ids)
    ? body.relation_ids.filter(s => typeof s === 'string' && s.length > 0)
    : []

  if (!tier)               return NextResponse.json({ error: 'tier must be 1 or 2' }, { status: 400 })
  if (relationIds.length === 0) return NextResponse.json({ error: 'relation_ids must not be empty' }, { status: 400 })
  if (relationIds.length > 200) return NextResponse.json({ error: 'Too many — max 200 per call' }, { status: 400 })

  // ── Load catalog rows for the requested relation_ids ─────────────────────
  const { data: catalogRows, error: catErr } = await db
    .from('g2g_products')
    .select('relation_id, brand_name, service_name, is_active')
    .in('relation_id', relationIds)
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 })

  const catalogMap = new Map<string, { brand_name: string; service_name: string; is_active: boolean }>()
  for (const r of catalogRows ?? []) catalogMap.set(r.relation_id, r)

  // ── Sprint UNIFY.5 — Load KB canonical categories for service_name → KB translation
  // So tier rows get the KB canonical name (e.g. "Games/Key") instead of
  // raw catalog "Activation Links". Stays consistent with the rest of the app.
  const { data: kbRows } = await db
    .from('knowledge_base_items')
    .select('name, data')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('category', 'category')
  const kbList: KbCategory[] = (kbRows ?? []).map(r => {
    const d = (r.data ?? {}) as Record<string, unknown>
    return {
      name:                  String(r.name),
      catalog_service_match: (d.catalog_service_match as string) ?? null,
    }
  })

  // ── Snapshot existing tier rows so we can label updates vs inserts ──────
  const { data: existing } = await db
    .from('product_tiers')
    .select('relation_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('relation_id', relationIds)
  const existingSet = new Set((existing ?? []).map(r => r.relation_id as string))

  // ── Build payload ────────────────────────────────────────────────────────
  const now = new Date().toISOString()
  const skipped: { relation_id: string; reason: string }[] = []
  const payload = relationIds.flatMap(relationId => {
    const row = catalogMap.get(relationId)
    if (!row) {
      skipped.push({ relation_id: relationId, reason: 'not found in g2g_products' })
      return []
    }
    if (!row.is_active) {
      skipped.push({ relation_id: relationId, reason: 'product is inactive in catalog' })
      return []
    }
    // Translate raw catalog service_name to KB canonical (fallback to raw
    // if KB is empty or no match found). Sprint UNIFY.5.
    const canonicalCategory = kbList.length
      ? (mapToKbCanonical(row.service_name, kbList, 1) ?? row.service_name)
      : row.service_name
    return [{
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      tier,
      relation_id:   relationId,
      product_name:  row.brand_name,
      category:      canonicalCategory,
      url:           null,
      notes:         null,
      updated_at:    now,
    }]
  })

  if (payload.length === 0) {
    return NextResponse.json({ inserted: 0, updated: 0, skipped }, { status: 200 })
  }

  // ── Bulk upsert by (owner, site_slug, relation_id) ──────────────────────
  const { error: upErr } = await db
    .from('product_tiers')
    .upsert(payload, { onConflict: 'owner_user_id,site_slug,relation_id' })
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  const updated  = payload.filter(p => existingSet.has(p.relation_id)).length
  const inserted = payload.length - updated

  return NextResponse.json({ inserted, updated, skipped })
}
