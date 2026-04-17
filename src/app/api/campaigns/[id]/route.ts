import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string }> }

// ── PATCH /api/campaigns/[id] — update campaign details ─────────────────────
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  const body = await request.json() as {
    name?: string
    description?: string
    color?: string
    gsc_site_url?: string
    parent_campaign_id?: string | null
    goals?: Record<string, unknown>
    status?: string
    campaign_notes?: string | null
  }

  const updates: Record<string, unknown> = {}
  if (body.name             !== undefined) updates.name               = body.name?.trim()
  if (body.description      !== undefined) updates.description        = body.description
  if (body.color            !== undefined) updates.color              = body.color
  if (body.gsc_site_url     !== undefined) updates.gsc_site_url       = body.gsc_site_url
  if (body.parent_campaign_id !== undefined) updates.parent_campaign_id = body.parent_campaign_id
  if (body.goals            !== undefined) updates.goals              = body.goals
  if (body.status           !== undefined) updates.status             = body.status
  if (body.campaign_notes   !== undefined) updates.campaign_notes     = body.campaign_notes

  const { error } = await supabase
    .from('campaigns')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── DELETE /api/campaigns/[id] — delete campaign (pages cascade) ─────────────
export async function DELETE(_request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  const { error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
