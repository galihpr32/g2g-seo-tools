import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string; pageId: string }> }

// ── PATCH /api/campaigns/[id]/pages/[pageId] — update page notes/status/eta ──
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { pageId } = await params

  const body = await request.json() as {
    notes?: string | null
    status?: string
    eta?: string | null
  }

  const updates: Record<string, unknown> = {}
  if (body.notes  !== undefined) updates.notes  = body.notes
  if (body.status !== undefined) updates.status = body.status
  if (body.eta    !== undefined) updates.eta    = body.eta

  const { error } = await supabase
    .from('campaign_pages')
    .update(updates)
    .eq('id', pageId)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
