import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * POST /api/forseti/threads/[id]/responses
 *
 * Log a response (reply, internal_note, or escalation) on a thread.
 * Status transitions are recorded via PATCH /api/forseti/threads instead.
 *
 * Body: {
 *   response_type: 'reply' | 'internal_note' | 'escalation'
 *   response_text: string
 *   response_url?: string          // Reddit comment permalink after posting
 *   outcome_note?: string
 *   new_status?: string            // optional status transition in same call
 * }
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const { id }  = await ctx.params

  const body = await req.json().catch(() => ({})) as {
    response_type?: string
    response_text?: string
    response_url?:  string
    outcome_note?:  string
    new_status?:    string
  }

  const type = (body.response_type === 'internal_note' || body.response_type === 'escalation')
    ? body.response_type
    : 'reply'

  const text = String(body.response_text ?? '').trim().slice(0, 8000)
  if (!text && type === 'reply') {
    return NextResponse.json({ error: 'response_text required for reply' }, { status: 400 })
  }

  // Verify thread belongs to caller
  const { data: thread, error: tErr } = await db
    .from('forseti_threads')
    .select('id, status')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (tErr)    return NextResponse.json({ error: tErr.message }, { status: 500 })
  if (!thread) return NextResponse.json({ error: 'Thread not found' }, { status: 404 })

  const statusBefore = thread.status as string

  // Insert the response row
  const { data: inserted, error: insErr } = await db.from('forseti_thread_responses').insert({
    thread_id:         id,
    owner_user_id:     ownerId,
    response_type:     type,
    response_text:     text || null,
    response_url:      String(body.response_url ?? '').trim() || null,
    outcome_note:      String(body.outcome_note ?? '').trim() || null,
    posted_by_user_id: user.id,
    status_before:     statusBefore,
    status_after:      body.new_status ?? null,
  }).select('*').single()

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  // Optional status transition in same call (saves an extra round-trip)
  if (typeof body.new_status === 'string' && body.new_status !== statusBefore) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const patch: Record<string, any> = { status: body.new_status, updated_at: new Date().toISOString() }
    if (body.new_status === 'sent' || body.new_status === 'op_replied') patch.responded_at = new Date().toISOString()
    if (body.new_status === 'resolved' || body.new_status === 'escalated') patch.resolved_at = new Date().toISOString()
    await db.from('forseti_threads').update(patch).eq('id', id)
  }

  return NextResponse.json({ response: inserted })
}
