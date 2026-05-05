import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/news/sources           — list all news_sources for the owner
 * POST /api/news/sources          — add a new RSS source
 *   body: { name, rss_url, homepage_url?, category?, notes? }
 * PATCH /api/news/sources?id=…    — toggle is_active or update fields
 *   body: { is_active?, name?, rss_url?, category?, notes? }
 * DELETE /api/news/sources?id=…   — remove source (cascade deletes items)
 */

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data, error } = await db
    .from('news_sources')
    .select('id, name, rss_url, homepage_url, category, is_active, last_fetched_at, last_item_count, notes, created_at')
    .eq('owner_user_id', ownerId)
    .order('name', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sources: data ?? [] })
}

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await request.json().catch(() => ({})) as {
    name?: string; rss_url?: string; homepage_url?: string; category?: string; notes?: string
  }
  const { name, rss_url, homepage_url, category, notes } = body
  if (!name?.trim() || !rss_url?.trim()) {
    return NextResponse.json({ error: 'name + rss_url required' }, { status: 400 })
  }
  try { new URL(rss_url) } catch {
    return NextResponse.json({ error: 'rss_url must be a valid URL' }, { status: 400 })
  }

  const { data, error } = await db
    .from('news_sources')
    .insert({
      owner_user_id: ownerId,
      name:          name.trim(),
      rss_url:       rss_url.trim(),
      homepage_url:  homepage_url?.trim() || null,
      category:      category || 'general',
      notes:         notes?.slice(0, 500) || null,
      is_active:     true,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'This RSS URL is already in your sources list' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ source: data })
}

export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  const body = await request.json().catch(() => ({})) as {
    is_active?: boolean; name?: string; rss_url?: string; category?: string; notes?: string
  }
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active
  if (typeof body.name      === 'string')  update.name      = body.name.trim()
  if (typeof body.rss_url   === 'string')  update.rss_url   = body.rss_url.trim()
  if (typeof body.category  === 'string')  update.category  = body.category
  if (typeof body.notes     === 'string')  update.notes     = body.notes.slice(0, 500)

  const { error } = await db
    .from('news_sources')
    .update(update)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id query param required' }, { status: 400 })

  const { error } = await db
    .from('news_sources')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
