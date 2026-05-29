import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * PUT    /api/priority-products/[id]/keywords/[kwId]  — update (rename, toggle is_main, set notes)
 * DELETE /api/priority-products/[id]/keywords/[kwId]  — remove keyword + cascade its snapshots
 */

interface PatchBody {
  keyword?:  string
  is_main?:  boolean
  notes?:    string | null
  position?: number
  language?: string   // Sprint TIER.PER.MARKET.KW — 'en' | 'id'
}

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string; kwId: string }> },
) {
  const { id: productId, kwId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as PatchBody

  // Demote existing main if we're promoting this one
  if (body.is_main === true) {
    await db
      .from('tier_keywords')
      .update({ is_main: false, updated_at: new Date().toISOString() })
      .eq('owner_user_id', ownerId)
      .eq('product_tier_id', productId)
      .eq('is_main', true)
      .neq('id', kwId)
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.keyword  !== undefined) patch.keyword  = body.keyword.trim()
  if (body.is_main  !== undefined) patch.is_main  = !!body.is_main
  if (body.notes    !== undefined) patch.notes    = body.notes?.trim() || null
  if (body.position !== undefined) patch.position = body.position
  if (body.language !== undefined) {
    const lang = body.language.trim().toLowerCase()
    if (lang !== 'en' && lang !== 'id') {
      return NextResponse.json({ error: 'language must be "en" or "id"' }, { status: 400 })
    }
    patch.language = lang
  }

  const { data, error } = await db
    .from('tier_keywords')
    .update(patch)
    .eq('id', kwId)
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Keyword already exists for this product' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data)  return NextResponse.json({ error: 'Keyword not found' }, { status: 404 })
  return NextResponse.json({ item: data })
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; kwId: string }> },
) {
  const { id: productId, kwId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // FK cascade: tier_serp_snapshots.tier_keyword_id was set to SET NULL on
  // delete, so we keep historical SERP data even after a keyword is removed.
  // If you want to wipe history too, change to ON DELETE CASCADE in the migration.
  const { error } = await db
    .from('tier_keywords')
    .delete()
    .eq('id', kwId)
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
