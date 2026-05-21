import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * PUT    /api/product-tiers/[id]  — update a tier entry
 * DELETE /api/product-tiers/[id]  — remove
 *
 * Both verify the row belongs to the calling user before touching it. RLS
 * also enforces this server-side, but we double-check here for clearer 404 vs
 * 403 semantics.
 */

interface PatchBody {
  tier?:             1 | 2
  product_name?:     string
  category?:         string | null
  brand_canonical?:  string | null   // Sprint CLUSTER.RENAME.5 — canonical brand override
  relation_id?:      string | null
  url?:              string | null
  notes?:            string | null
  restriction_type?: string | null   // Sprint DMCA.TAGGING — DMCA | Trademark | RegionLock | TOS | null
  market?:           string          // Sprint TIER.PER.MARKET — 'us' | 'id'
}

const VALID_RESTRICTIONS = ['DMCA', 'Trademark', 'RegionLock', 'TOS'] as const
const VALID_MARKETS = ['us', 'id'] as const

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as PatchBody

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.tier !== undefined) {
    if (body.tier !== 1 && body.tier !== 2) {
      return NextResponse.json({ error: 'tier must be 1 or 2' }, { status: 400 })
    }
    patch.tier = body.tier
  }
  if (body.product_name !== undefined)    patch.product_name    = body.product_name.trim()
  if (body.category !== undefined)        patch.category        = body.category?.trim() || null
  if (body.brand_canonical !== undefined) patch.brand_canonical = body.brand_canonical?.trim() || null
  if (body.relation_id !== undefined)     patch.relation_id     = body.relation_id?.trim() || null
  if (body.url !== undefined)          patch.url          = body.url?.trim() || null
  if (body.notes !== undefined)        patch.notes        = body.notes?.trim() || null
  if (body.restriction_type !== undefined) {
    const r = body.restriction_type?.trim() || null
    if (r && !(VALID_RESTRICTIONS as readonly string[]).includes(r)) {
      return NextResponse.json({ error: `restriction_type must be one of: ${VALID_RESTRICTIONS.join(', ')} or null` }, { status: 400 })
    }
    patch.restriction_type = r
  }
  if (body.market !== undefined) {
    const m = body.market.trim().toLowerCase()
    if (!(VALID_MARKETS as readonly string[]).includes(m)) {
      return NextResponse.json({ error: `market must be one of: ${VALID_MARKETS.join(', ')}` }, { status: 400 })
    }
    patch.market = m
  }

  const { data, error } = await db
    .from('product_tiers')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  // Sprint TIER.PER.MARKET — DMCA / restriction_type is product-level
  // (Galih's confirmation: "DMCA per produk aja"). When the user toggles
  // restriction on one market row, propagate the same value to any other
  // market rows for the same (owner × site × relation_id) so they stay
  // in sync. Fire-and-forget — failures here don't break the primary write.
  if (data && body.restriction_type !== undefined && data.relation_id) {
    void db
      .from('product_tiers')
      .update({ restriction_type: patch.restriction_type, updated_at: new Date().toISOString() })
      .eq('owner_user_id', ownerId)
      .eq('site_slug',     data.site_slug)
      .eq('relation_id',   data.relation_id)
      .neq('id', id)
      .then(() => {/* silent */}, () => {/* silent */})
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ item: data })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { error } = await db
    .from('product_tiers')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
