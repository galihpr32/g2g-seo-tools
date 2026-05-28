import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

/**
 * GET /api/g2g-catalog/coverage
 *
 * Answers: of the N active G2G products, how many do we already cover?
 *
 *   - has_content    — product_content_queue.status = 'generated'
 *   - has_uploaded   — product_content_queue.cms_upload_status = 'uploaded'
 *   - has_tier       — product_tiers row exists for this owner × site
 *   - has_keywords   — tier_keywords row exists (joined via product_tiers.relation_id)
 *
 * Returned both overall + per service_name so the dashboard can render a
 * matrix and highlight under-served categories.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  // ── 1. Catalog ─────────────────────────────────────────────────────────
  const { data: catalog, error: catErr } = await db
    .from('g2g_products')
    .select('relation_id, service_name')
    .eq('is_active', true)
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 })

  const totalActive = catalog?.length ?? 0
  if (totalActive === 0) {
    return NextResponse.json({
      total_active: 0,
      coverage:     { has_content: 0, has_uploaded: 0, has_tier: 0, has_keywords: 0 },
      by_service:   [],
      message:      'Catalog is empty — import the CSV first.',
    })
  }

  // ── 2. Coverage sets (one query each) ──────────────────────────────────
  const allRel = (catalog ?? []).map(r => r.relation_id)
  const [pcContent, pcUpload, tiers] = await Promise.all([
    db.from('product_content_queue').select('relation_id').eq('owner_user_id', ownerId).eq('status', 'generated'),
    db.from('product_content_queue').select('relation_id').eq('owner_user_id', ownerId).eq('cms_upload_status', 'uploaded'),
    db.from('product_tiers').select('id, relation_id').eq('owner_user_id', ownerId).eq('site_slug', siteSlug),
  ])

  const contentSet  = new Set<string>((pcContent.data ?? []).map(r => r.relation_id))
  const uploadSet   = new Set<string>((pcUpload.data ?? []).map(r => r.relation_id))
  const tierRows    = tiers.data ?? []
  const tierRelSet  = new Set<string>(tierRows.map(r => r.relation_id).filter(Boolean) as string[])
  const tierIds     = tierRows.map(r => r.id)

  // tier_keywords joins via tier id, so reverse-lookup by tier_product_id
  let kwTierIds = new Set<string>()
  if (tierIds.length) {
    const { data: kwRows } = await db
      .from('tier_keywords')
      .select('tier_product_id')
      .in('tier_product_id', tierIds)
    kwTierIds = new Set<string>((kwRows ?? []).map(r => r.tier_product_id))
  }
  // Map keyword-bearing tier rows back to relation_ids
  const kwRelSet = new Set<string>(tierRows.filter(r => kwTierIds.has(r.id) && r.relation_id).map(r => r.relation_id as string))

  // ── 3. Roll-up per service_name ────────────────────────────────────────
  type Bucket = {
    service_name: string
    total:        number
    has_content:  number
    has_uploaded: number
    has_tier:     number
    has_keywords: number
  }
  const buckets = new Map<string, Bucket>()
  for (const r of catalog ?? []) {
    const b = buckets.get(r.service_name) ?? {
      service_name: r.service_name, total: 0, has_content: 0, has_uploaded: 0, has_tier: 0, has_keywords: 0,
    }
    b.total++
    if (contentSet.has(r.relation_id)) b.has_content++
    if (uploadSet.has(r.relation_id))  b.has_uploaded++
    if (tierRelSet.has(r.relation_id)) b.has_tier++
    if (kwRelSet.has(r.relation_id))   b.has_keywords++
    buckets.set(r.service_name, b)
  }

  // Overall totals
  const overall = {
    has_content:  allRel.filter(r => contentSet.has(r)).length,
    has_uploaded: allRel.filter(r => uploadSet.has(r)).length,
    has_tier:     allRel.filter(r => tierRelSet.has(r)).length,
    has_keywords: allRel.filter(r => kwRelSet.has(r)).length,
  }

  return NextResponse.json({
    total_active: totalActive,
    coverage:     overall,
    by_service:   Array.from(buckets.values()).sort((a, b) => b.total - a.total),
  })
}
