import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData } from '@/lib/workspace'

export const maxDuration = 10

/**
 * POST /api/content/briefs/[id]/review-reasons
 *
 * Reviewer-supplied reasons for the most-recent diff capture. Called by the
 * editor's "why did you change this?" modal after save. Each entry updates
 * brief_review_feedback.reason_freetext for the matching section_label.
 *
 * Body: { reasons: { [section_label]: string } }
 *
 * Idempotent — re-posting overwrites the freetext. The Haiku classifier
 * (Sprint LEARN.4) picks up new freetext on its next pass.
 */
export async function POST(
  req:  Request,
  ctx:  { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { reasons?: Record<string, string> }
  const reasons = body.reasons ?? {}
  if (Object.keys(reasons).length === 0) {
    return NextResponse.json({ error: 'reasons map cannot be empty' }, { status: 400 })
  }

  const db = createServiceClient()
  const { data: briefMeta } = await db
    .from('seo_content_briefs')
    .select('owner_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!briefMeta) return NextResponse.json({ error: 'Brief not found' }, { status: 404 })

  const ownerId = String(briefMeta.owner_user_id)
  const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Find the most-recent feedback row per section_label for this brief
  // (typically the row just captured by the brief PATCH endpoint).
  let updated = 0
  for (const [section, reason] of Object.entries(reasons)) {
    const text = String(reason ?? '').trim().slice(0, 1000)
    if (!text) continue

    // Update the latest matching row for this (brief × section) combo.
    // Sub-select is the simplest way to "update latest one".
    const { data: latest } = await db
      .from('brief_review_feedback')
      .select('id')
      .eq('brief_id', id)
      .eq('section_label', section)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) continue

    const { error: upErr } = await db
      .from('brief_review_feedback')
      .update({ reason_freetext: text, reason_classified: null /* re-classify */ })
      .eq('id', latest.id)
    if (!upErr) updated++
  }

  return NextResponse.json({ ok: true, updated })
}
