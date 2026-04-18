import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string }> }

// ── PATCH /api/dmca/[id] ──────────────────────────────────────────────────────
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params
  const body = await request.json() as {
    original_term?: string
    replacement_term?: string
    notes?: string | null
    active?: boolean
  }

  const updates: Record<string, unknown> = {}
  if (body.original_term    !== undefined) updates.original_term    = body.original_term.trim()
  if (body.replacement_term !== undefined) updates.replacement_term = body.replacement_term.trim()
  if (body.notes            !== undefined) updates.notes            = body.notes
  if (body.active           !== undefined) updates.active           = body.active

  const { error } = await supabase
    .from('dmca_terms')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── DELETE /api/dmca/[id] ─────────────────────────────────────────────────────
export async function DELETE(_req: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  const { error } = await supabase
    .from('dmca_terms')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
