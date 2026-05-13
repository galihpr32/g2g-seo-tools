import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * PATCH /api/content/briefs/[id]/blocker
 *   body: { reason: string | null }   — null clears the blocker
 *
 * Sets blocker_reason + blocked_at atomically. UI calls this from the
 * brief library row + brief detail page.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  const reason = typeof body.reason === 'string' ? body.reason.trim() : null

  const db = createServiceClient()
  const patch: Record<string, unknown> = reason
    ? { blocker_reason: reason, blocked_at: new Date().toISOString() }
    : { blocker_reason: null, blocked_at: null }

  const { data, error } = await db
    .from('seo_content_briefs')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select('id, blocker_reason, blocked_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ brief: data })
}
