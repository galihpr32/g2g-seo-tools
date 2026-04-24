import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET /api/competitive/keyword-gap/snapshots/[id] ───────────────────────────
// Loads full analysis result (including all keyword rows)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  const { data, error } = await db
    .from('keyword_gap_snapshots')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(data)
}

// ── DELETE /api/competitive/keyword-gap/snapshots/[id] ────────────────────────
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id } = await params

  await db
    .from('keyword_gap_snapshots')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  return NextResponse.json({ ok: true })
}
