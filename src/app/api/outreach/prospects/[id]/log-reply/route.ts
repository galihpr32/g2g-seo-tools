import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * POST /api/outreach/prospects/[id]/log-reply
 * Body: {
 *   direction: 'outbound' | 'inbound',
 *   sentiment?: 'positive' | 'neutral' | 'negative',
 *   body: string,
 * }
 *
 * Appends to outreach_prospects.replies and updates sent_count /
 * last_sent_at / last_replied_at counters so the funnel + follow-up
 * filter work without scanning the JSONB array each time.
 *
 * On inbound 'positive' replies, optionally bumps status from 'contacted' →
 * 'negotiating' (heuristic — Specialist 2 can override).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id }  = await params
  const body    = await request.json().catch(() => ({}))

  const { direction, sentiment, body: emailBody } = body
  if (!['outbound', 'inbound'].includes(direction)) {
    return NextResponse.json({ error: 'direction must be outbound or inbound' }, { status: 400 })
  }
  if (!emailBody?.trim() || typeof emailBody !== 'string') {
    return NextResponse.json({ error: 'body required' }, { status: 400 })
  }

  const db = createServiceClient()

  // Load current row to read existing replies
  const { data: prospect, error: loadErr } = await db
    .from('outreach_prospects')
    .select('id, replies, sent_count, status')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (loadErr || !prospect) {
    return NextResponse.json({ error: loadErr?.message ?? 'Prospect not found' }, { status: 404 })
  }

  const now = new Date().toISOString()
  const newEntry = {
    ts:        now,
    direction: direction as 'outbound' | 'inbound',
    sentiment: ['positive', 'neutral', 'negative'].includes(sentiment) ? sentiment : null,
    body:      String(emailBody).slice(0, 5000).trim(),
    logged_by: user.id,
  }
  const existingReplies = Array.isArray(prospect.replies) ? prospect.replies : []
  const newReplies = [...existingReplies, newEntry]

  const updates: Record<string, unknown> = {
    replies:    newReplies,
    updated_at: now,
  }

  if (direction === 'outbound') {
    updates.sent_count   = Number(prospect.sent_count ?? 0) + 1
    updates.last_sent_at = now
    // If first outbound — also flip status from prospecting → contacted
    if (prospect.status === 'prospecting') {
      updates.status = 'contacted'
    }
  } else {
    updates.last_replied_at = now
    // Heuristic: positive inbound on a 'contacted' prospect → 'negotiating'
    if (sentiment === 'positive' && prospect.status === 'contacted') {
      updates.status = 'negotiating'
    }
  }

  const { error: updErr } = await db
    .from('outreach_prospects')
    .update(updates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({
    ok:           true,
    repliesCount: newReplies.length,
    nextStatus:   updates.status ?? prospect.status,
  })
}
