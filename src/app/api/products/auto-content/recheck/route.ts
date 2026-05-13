import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST /api/products/auto-content/recheck
 *
 * Backfills stale rows where:
 *   - status = 'generated' but google_doc_url IS NULL  → reset to 'pending'
 *   - id_status = 'generated' but id_google_doc_url IS NULL → reset id_status to 'pending'
 *
 * Why this exists: before the `enSucceeded` gate landed (2026-05-08), the
 * processor would mark a row as 'generated' even if Drive doc creation had
 * silently failed (returned empty URL). Those rows look fine in the queue
 * but have no artifact for the team to upload. This endpoint sweeps them
 * back to 'pending' so the auto-process cron picks them up again on its
 * next tick.
 *
 * Returns: { resetEn: number, resetId: number }
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const nowIso = new Date().toISOString()

  // ── EN: rows marked generated but with no doc URL → reset to pending
  // We also clear generated_at so the timestamp doesn't lie about a non-existent
  // doc, and clear generation_error so the next attempt isn't pre-tainted.
  const { data: enReset, error: enErr } = await db
    .from('product_content_queue')
    .update({
      status:           'pending',
      generated_at:     null,
      generation_error: null,
      updated_at:       nowIso,
    })
    .eq('owner_user_id', ownerId)
    .eq('status', 'generated')
    .is('google_doc_url', null)
    .select('id')

  if (enErr) return NextResponse.json({ error: enErr.message }, { status: 500 })

  // ── ID: id_status='generated' but id_google_doc_url is null → reset id_status
  // We don't bump status here — only the ID side is bad.
  const { data: idReset, error: idErr } = await db
    .from('product_content_queue')
    .update({
      id_status:           'pending',
      id_generated_at:     null,
      id_generation_error: null,
      updated_at:          nowIso,
    })
    .eq('owner_user_id', ownerId)
    .eq('id_status', 'generated')
    .is('id_google_doc_url', null)
    .select('id')

  if (idErr) return NextResponse.json({ error: idErr.message }, { status: 500 })

  return NextResponse.json({
    ok:      true,
    resetEn: enReset?.length ?? 0,
    resetId: idReset?.length ?? 0,
  })
}
