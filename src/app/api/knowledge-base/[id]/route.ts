import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params
  const body = await request.json() as { name?: string; data?: Record<string, unknown> }

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.data !== undefined) updates.data = body.data

  const { error } = await supabase
    .from('knowledge_base_items')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  const { error } = await supabase
    .from('knowledge_base_items')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
