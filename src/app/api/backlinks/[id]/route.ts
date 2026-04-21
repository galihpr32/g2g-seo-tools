import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── PATCH /api/backlinks/[id] — update a backlink ────────────────────────────
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json()
  const allowedFields = [
    'site_name', 'external_url', 'anchor_text', 'target_page', 'target_keyword',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'link_status', 'cost_amount', 'cost_currency', 'live_date', 'notes',
    'last_checked_at', 'check_method', 'position_current', 'position_history',
  ]
  const updates: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (field in body) updates[field] = body[field]
  }

  const { data, error } = await db
    .from('paid_backlinks')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ backlink: data })
}

// ── DELETE /api/backlinks/[id] — delete a backlink ───────────────────────────
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { error } = await db
    .from('paid_backlinks')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
