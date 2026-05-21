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
  tier:              1 | 2
  product_name:      string
  category?:         string | null
  brand_canonical?:  string | null   // Sprint CLUSTER.RENAME.5
  relation_id?:      string | null
  url?:              string | null
  notes?:            string | null
  restriction_type?: string | null   // Sprint DMCA.TAGGING
  market?:           string          // Sprint TIER.PER.MARKET — 'us' | 'id', defaults to 'us'
}

const VALID_RESTRICTIONS = ['DMCA', 'Trademark', 'RegionLock', 'TOS'] as const
const VALID_MARKETS = ['us', 'id'] as const

function normalizeBody(body: TierBody): {
  ok:    true
  data:  { tier: 1 | 2; product_name: string; category: string | null; brand_canonical: string | null; relation_id: string | null; url: string | null; notes: string | null; restriction_type: string | null; market: 'us' | 'id' }
} | { ok: false; error: string } {
  if (body.tier !== 1 && body.tier !== 2) return { ok: false, error: 'tier must be 1 or 2' }
  if (!body.product_name?.trim())         return { ok: false, error: 'product_name is required' }
  if (!body.relation_id && !body.url && !body.product_name) {
    return { ok: false, error: 'At least one of relation_id, url, or product_name is required' }
  }
  const restriction = body.restriction_type?.trim() || null
  if (restriction && !(VALID_RESTRICTIONS as readonly string[]).includes(restriction)) {
    return { ok: false, error: `restriction_type must be one of: ${VALID_RESTRICTIONS.join(', ')} or null` }
  }
  const market = (body.market?.trim().toLowerCase() || 'us') as 'us' | 'id'
  if (!(VALID_MARKETS as readonly string[]).includes(market)) {
    return { ok: false, error: `market must be one of: ${VALID_MARKETS.join(', ')}` }
  }
  return {
    ok: true,
    data: {
      tier:             body.tier,
      product_name:     body.product_name.trim(),
      category:         body.category?.trim() || null,
      brand_canonical:  body.brand_canonical?.trim() || null,
      relation_id:      body.relation_id?.trim() || null,
      url:              body.url?.trim() || null,
      notes:            body.notes?.trim() || null,
      restriction_type: restriction,
      market,
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

  // Sprint TIER.PER.MARKET — per-market breakdown for the admin UI to show
  // "US tier 1: 12 / 10 · ID tier 1: 8 / 10" type stats.
  const byMarket: Record<string, { t1: number; t2: number; total: number }> = {
    us: { t1: 0, t2: 0, total: 0 },
    id: { t1: 0, t2: 0, total: 0 },
  }
  for (const r of rows) {
    const m = (r.market ?? 'us') as 'us' | 'id'
    byMarket[m] ??= { t1: 0, t2: 0, total: 0 }
    if (r.tier === 1) byMarket[m].t1 += 1
    else              byMarket[m].t2 += 1
    byMarket[m].total += 1
  }

  return NextResponse.json({
    items: rows,
    stats: {
      tier1: t1, tier2: t2, total: rows.length,
      // Legacy global byCategory (count only) — kept for backward compat.
      byCategory: Object.fromEntries(Object.entries(byCategoryTier).map(([k, v]) => [k, v.total])),
      byCategoryTier,
      byMarket,
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
    // Sprint TIER.PER.MARKET — conflict key now includes market so the same
    // product can have separate rows for us + id (e.g. dual-focus brand).
    const { data, error } = await db
      .from('product_tiers')
      .upsert({
        owner_user_id: ownerId,
        site_slug:     siteSlug,
        ...norm.data,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'owner_user_id,site_slug,market,relation_id' })
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
