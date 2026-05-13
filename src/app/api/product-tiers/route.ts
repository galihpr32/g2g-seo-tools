import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { mapToKbCanonical, type KbCategory } from '@/lib/category-mapping'

/**
 * GET  /api/product-tiers       — list all tiers for current site
 * POST /api/product-tiers       — create new entry (or upsert by relation_id)
 *
 * site_slug comes from the active brand context (cookie/header/URL prefix).
 * Both endpoints are RLS-isolated to the calling user via owner_user_id.
 */

interface TierBody {
  tier:         1 | 2
  product_name: string
  category?:    string | null
  relation_id?: string | null
  url?:         string | null
  notes?:       string | null
}

function normalizeBody(body: TierBody): {
  ok:    true
  data:  { tier: 1 | 2; product_name: string; category: string | null; relation_id: string | null; url: string | null; notes: string | null }
} | { ok: false; error: string } {
  if (body.tier !== 1 && body.tier !== 2) return { ok: false, error: 'tier must be 1 or 2' }
  if (!body.product_name?.trim())         return { ok: false, error: 'product_name is required' }
  if (!body.relation_id && !body.url && !body.product_name) {
    return { ok: false, error: 'At least one of relation_id, url, or product_name is required' }
  }
  return {
    ok: true,
    data: {
      tier:         body.tier,
      product_name: body.product_name.trim(),
      category:     body.category?.trim() || null,
      relation_id:  body.relation_id?.trim() || null,
      url:          body.url?.trim() || null,
      notes:        body.notes?.trim() || null,
    },
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { data, error } = await db
    .from('product_tiers')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('tier', { ascending: true })
    .order('product_name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Compact stats for header cards on the admin page.
  // Galih's model: each CATEGORY has its own Top 10 (Tier 1) + Next 25 (Tier 2).
  // So caps are per-category, not global. Stats reflect that.
  const rows = data ?? []
  const t1   = rows.filter(r => r.tier === 1).length
  const t2   = rows.filter(r => r.tier === 2).length

  // Per-category × per-tier breakdown.
  // byCategoryTier[category] = { t1, t2, total }
  const byCategoryTier: Record<string, { t1: number; t2: number; total: number }> = {}
  for (const r of rows) {
    const k = r.category?.trim() || 'Uncategorized'
    byCategoryTier[k] ??= { t1: 0, t2: 0, total: 0 }
    if (r.tier === 1) byCategoryTier[k].t1 += 1
    else              byCategoryTier[k].t2 += 1
    byCategoryTier[k].total += 1
  }

  return NextResponse.json({
    items: rows,
    stats: {
      tier1: t1, tier2: t2, total: rows.length,
      // Legacy global byCategory (count only) — kept for backward compat.
      byCategory: Object.fromEntries(Object.entries(byCategoryTier).map(([k, v]) => [k, v.total])),
      byCategoryTier,
    },
  })
}

// ─── POST (create or upsert) ─────────────────────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as TierBody
  const norm = normalizeBody(body)
  if (!norm.ok) return NextResponse.json({ error: norm.error }, { status: 400 })

  // Sprint UNIFY.5 — Translate the submitted category to KB canonical if a
  // close match exists. Keeps everything aligned with the team-curated list.
  if (norm.data.category) {
    const { data: kbRows } = await db
      .from('knowledge_base_items')
      .select('name, data')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('category', 'category')
    if (kbRows?.length) {
      const kbList: KbCategory[] = kbRows.map(r => {
        const d = (r.data ?? {}) as Record<string, unknown>
        return {
          name:                  String(r.name),
          catalog_service_match: (d.catalog_service_match as string) ?? null,
        }
      })
      const canonical = mapToKbCanonical(norm.data.category, kbList, 1)
      if (canonical) norm.data.category = canonical
    }
  }

  // If relation_id is set, upsert on the unique index — same product re-tagged
  // shouldn't create dupes. Otherwise plain insert.
  if (norm.data.relation_id) {
    const { data, error } = await db
      .from('product_tiers')
      .upsert({
        owner_user_id: ownerId,
        site_slug:     siteSlug,
        ...norm.data,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'owner_user_id,site_slug,relation_id' })
      .select()
      .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ item: data })
  }

  const { data, error } = await db
    .from('product_tiers')
    .insert({
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      ...norm.data,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
