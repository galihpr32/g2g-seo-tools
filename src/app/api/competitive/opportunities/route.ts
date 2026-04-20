import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 10

// GET /api/competitive/opportunities — list all
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { data, error } = await supabase
    .from('page_opportunities')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ opportunities: data ?? [] })
}

// POST /api/competitive/opportunities — create
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({}))
  const { cluster_name, game_category, keywords, avg_volume, total_volume, competitor_domain, notes } = body

  if (!cluster_name?.trim()) {
    return NextResponse.json({ error: 'cluster_name is required' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('page_opportunities')
    .insert({
      owner_user_id:     ownerId,
      cluster_name:      cluster_name.trim(),
      game_category:     game_category?.trim() ?? null,
      keywords:          Array.isArray(keywords) ? keywords : [],
      avg_volume:        avg_volume ?? null,
      total_volume:      total_volume ?? null,
      competitor_domain: competitor_domain?.trim() ?? null,
      notes:             notes?.trim() ?? null,
      status:            'new',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ opportunity: data })
}

// PATCH /api/competitive/opportunities?id=xxx — update status or notes
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
  if (body.status        !== undefined) updates.status        = body.status
  if (body.notes         !== undefined) updates.notes         = body.notes?.trim() ?? null
  if (body.cluster_name  !== undefined) updates.cluster_name  = body.cluster_name.trim()
  if (body.game_category !== undefined) updates.game_category = body.game_category?.trim() ?? null

  const { data, error } = await supabase
    .from('page_opportunities')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ opportunity: data })
}

// DELETE /api/competitive/opportunities?id=xxx
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('page_opportunities')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
