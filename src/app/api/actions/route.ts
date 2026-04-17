import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// POST /api/actions — create one or more action items from selected ranking drop pages
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', user.id)
    .single()

  if (!conn?.site_url) return NextResponse.json({ error: 'No GSC connection' }, { status: 400 })

  const body = await request.json()
  const { pages, action_type, notes, snapshot_date } = body as {
    pages: { page: string; clicks_drop: number; position_change: number }[]
    action_type: 'on_page' | 'off_page'
    notes?: string
    snapshot_date: string
  }

  if (!pages?.length || !action_type || !snapshot_date) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const inserts = pages.map(p => ({
    site_url: conn.site_url,
    page: p.page,
    action_type,
    notes: notes ?? null,
    snapshot_date,
    clicks_drop: p.clicks_drop,
    position_change: p.position_change,
    status: 'pending',
  }))

  const { data, error } = await supabase
    .from('seo_action_items')
    .insert(inserts)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ created: data?.length ?? 0 })
}

// PATCH /api/actions — update status (and optionally notes) of a single action item
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { id, status, notes } = body as { id: string; status?: string; notes?: string }
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const updates: Record<string, unknown> = {}
  if (status) {
    updates.status = status
    updates.completed_at = status === 'done' ? new Date().toISOString() : null
  }
  if (notes !== undefined) updates.notes = notes

  // RLS ensures user can only update their own items
  const { error } = await supabase
    .from('seo_action_items')
    .update(updates)
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
