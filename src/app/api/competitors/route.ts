import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 10

function getSiteSlug(req: Request): string {
  const url      = new URL(req.url)
  const cookieSite = req.headers.get('cookie')?.match(/active-site=([^;]+)/)?.[1] ?? 'g2g'
  return url.searchParams.get('site') ?? cookieSite
}

// GET /api/competitors?site=g2g — list competitors for the active site
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = getSiteSlug(req)
  const db = createServiceClient()
  const { data, error } = await db
    .from('competitors')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ competitors: data ?? [] })
}

// POST /api/competitors — create competitor for the active site
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = getSiteSlug(req)
  const db = createServiceClient()
  const body = await req.json().catch(() => ({}))
  const { domain, name, notes } = body

  if (!domain?.trim() || !name?.trim()) {
    return NextResponse.json({ error: 'domain and name are required' }, { status: 400 })
  }

  // Normalize domain: strip protocol + trailing slash
  const cleanDomain = domain.trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase()

  const { data, error } = await db
    .from('competitors')
    .insert({ owner_user_id: ownerId, site_slug: siteSlug, domain: cleanDomain, name: name.trim(), notes: notes?.trim() ?? null })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'This domain is already in your list' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ competitor: data })
}

// PATCH /api/competitors?id=xxx
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const db = createServiceClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name   !== undefined) updates.name   = body.name.trim()
  if (body.notes  !== undefined) updates.notes  = body.notes?.trim() ?? null
  if (body.active !== undefined) updates.active = body.active

  const { data, error } = await supabase
    .from('competitors')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ competitor: data })
}

// DELETE /api/competitors?id=xxx
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('competitors')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
