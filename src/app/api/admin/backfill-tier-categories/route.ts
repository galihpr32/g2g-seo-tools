import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { mapToKbCanonical, type KbCategory } from '@/lib/category-mapping'

export const maxDuration = 60

/**
 * POST /api/admin/backfill-tier-categories
 *
 * Walks every product_tiers row for the active owner × site and renames its
 * `category` field to the closest KB canonical via token overlap (lib/
 * category-mapping). Idempotent — rows whose category is already canonical
 * are skipped.
 *
 * Body: { dry_run?: boolean }  — default false. dry_run=true returns the
 *   proposed renames without writing.
 *
 * Returns:
 *   {
 *     scanned:      number,
 *     renamed:      number,
 *     unmapped:     number,
 *     dry_run:      boolean,
 *     renames:      [{ id, from, to }],
 *     unmapped_ids: [{ id, category }]
 *   }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { dry_run?: boolean }
  const dryRun = !!body.dry_run

  // 1. Load KB canonical list
  const { data: kbRows, error: kbErr } = await db
    .from('knowledge_base_items')
    .select('name, data')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('category', 'category')

  if (kbErr) return NextResponse.json({ error: kbErr.message }, { status: 500 })
  if (!kbRows?.length) {
    return NextResponse.json({
      error: 'No KB categories found. Add categories at /knowledge-base before backfilling.',
    }, { status: 400 })
  }

  const kbList: KbCategory[] = kbRows.map(r => {
    const d = (r.data ?? {}) as Record<string, unknown>
    return {
      name:                  String(r.name),
      catalog_service_match: (d.catalog_service_match as string) ?? null,
    }
  })
  const kbNameSet = new Set(kbList.map(k => k.name))

  // 2. Load all tier rows for this owner × site
  const { data: tiers, error: tErr } = await db
    .from('product_tiers')
    .select('id, category')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 })

  const renames: Array<{ id: string; from: string; to: string }> = []
  const unmapped: Array<{ id: string; category: string }> = []

  for (const row of tiers ?? []) {
    const current = (row.category ?? '').toString().trim()
    if (!current) continue
    // Already canonical — skip
    if (kbNameSet.has(current)) continue

    const canonical = mapToKbCanonical(current, kbList, 1)
    if (canonical && canonical !== current) {
      renames.push({ id: String(row.id), from: current, to: canonical })
    } else {
      unmapped.push({ id: String(row.id), category: current })
    }
  }

  // 3. Apply (unless dry-run)
  if (!dryRun && renames.length > 0) {
    // No bulk multi-value update in Supabase; loop sequentially (≤100 rows expected)
    for (const r of renames) {
      const { error: upErr } = await db
        .from('product_tiers')
        .update({ category: r.to, updated_at: new Date().toISOString() })
        .eq('id', r.id)
      if (upErr) {
        return NextResponse.json({
          error:    `Update failed at row ${r.id}: ${upErr.message}`,
          partial:  { renames_applied: renames.indexOf(r), total: renames.length },
        }, { status: 500 })
      }
    }
  }

  return NextResponse.json({
    scanned:      tiers?.length ?? 0,
    renamed:      dryRun ? 0 : renames.length,
    unmapped:     unmapped.length,
    dry_run:      dryRun,
    renames,
    unmapped_ids: unmapped,
    kb_canonical: kbList.map(k => k.name),
  })
}
