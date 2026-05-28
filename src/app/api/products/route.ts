import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

// GET /api/products — list tracked products for the active site
// Site is resolved via resolveSiteSlugFromRequest (query param > cookie > default 'g2g')
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()
  const { data, error } = await db
    .from('tracked_products')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ products: data ?? [] })
}

// POST /api/products — create a tracked product
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const body = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)

  const { name, page_url, keywords, market, notes } = body
  if (!name?.trim() || !page_url?.trim()) {
    return NextResponse.json({ error: 'name and page_url are required' }, { status: 400 })
  }

  const { data, error } = await db
    .from('tracked_products')
    .insert({
      owner_user_id: ownerId,
      site_slug:     siteSlug,
      name:          name.trim(),
      page_url:      page_url.trim(),
      keywords:      Array.isArray(keywords) ? keywords.filter(Boolean) : [],
      market:        market ?? 'us',
      notes:         notes?.trim() ?? null,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ product: data })
}

// DELETE /api/products?id=xxx
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('tracked_products')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// PATCH /api/products?id=xxx — update a product
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name     !== undefined) updates.name     = body.name.trim()
  if (body.page_url !== undefined) updates.page_url = body.page_url.trim()
  if (body.keywords !== undefined) updates.keywords = Array.isArray(body.keywords) ? body.keywords.filter(Boolean) : []
  if (body.market   !== undefined) updates.market   = body.market
  if (body.notes    !== undefined) updates.notes    = body.notes?.trim() ?? null
  if (body.active   !== undefined) updates.active   = body.active

  const { data, error } = await supabase
    .from('tracked_products')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ product: data })
}
