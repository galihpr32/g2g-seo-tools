import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST /api/priority-products/[id]/keywords  — add a keyword
 *   Body: { keyword: string, is_main?: boolean, notes?: string }
 *   When is_main=true, unsets is_main on any existing keyword for the product
 *   (only one main per product).
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    keyword?:  string
    is_main?:  boolean
    notes?:    string
    language?: string   // Sprint TIER.PER.MARKET.KW — 'en' | 'id', defaults to 'en'
  }
  const keyword = body.keyword?.trim()
  if (!keyword) return NextResponse.json({ error: 'keyword is required' }, { status: 400 })

  // Validate language (Sprint MARKETS.PRUNE migration enforced this at DB level
  // too via CHECK constraint, but reject early for clearer error message).
  const language = (body.language?.trim().toLowerCase() || 'en') as 'en' | 'id'
  if (language !== 'en' && language !== 'id') {
    return NextResponse.json({ error: 'language must be "en" or "id"' }, { status: 400 })
  }

  // Sanity: confirm the product belongs to this owner before touching keywords
  const { data: product } = await db
    .from('product_tiers')
    .select('id')
    .eq('id', productId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 })

  // If new keyword is main, demote the old main first. We do this in two steps
  // (not a single upsert) because we want to support multiple non-main keywords.
  if (body.is_main) {
    await db
      .from('tier_keywords')
      .update({ is_main: false, updated_at: new Date().toISOString() })
      .eq('owner_user_id', ownerId)
      .eq('product_tier_id', productId)
      .eq('is_main', true)
  }

  // Compute display position — append to the end.
  const { data: existing } = await db
    .from('tier_keywords')
    .select('position')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .order('position', { ascending: false })
    .limit(1)
  const nextPos = ((existing?.[0]?.position as number | undefined) ?? 0) + 1

  const { data, error } = await db
    .from('tier_keywords')
    .insert({
      owner_user_id:   ownerId,
      product_tier_id: productId,
      keyword,
      language,
      is_main:         !!body.is_main,
      position:        nextPos,
      notes:           body.notes?.trim() || null,
    })
    .select()
    .single()

  if (error) {
    // Unique violation → duplicate keyword
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Keyword already exists for this product' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ item: data })
}

/**
 * GET /api/priority-products/[id]/keywords — list only (lighter than the
 * full detail endpoint, used by add-keyword form for dedupe check).
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: productId } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data, error } = await db
    .from('tier_keywords')
    .select('id, keyword, language, is_main, position, notes, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productId)
    .order('is_main', { ascending: false })
    .order('position', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data ?? [] })
}
