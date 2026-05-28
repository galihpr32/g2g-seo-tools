import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * Sprint MIMIR.POLISH.5 — Applied trace drill-down.
 *
 * GET /api/mimir/memories/[id]/applied
 *
 * Returns the list of briefs that injected this memory into their prompt,
 * sorted by recency. Reads from seo_content_briefs.mimir_notes_applied jsonb
 * (an array of { id, category, scope, content } populated by brief-generator).
 *
 * Caveat: this is a "denormalized" scan — we filter briefs where the memory
 * id appears anywhere in the applied jsonb. At our scale (~hundreds of
 * briefs per owner) the table-scan is fine. If briefs ever exceed ~10k, we'd
 * add a join table mimir_brief_application(memory_id, brief_id) instead.
 */
export async function GET(
  req:    Request,
  ctx:    { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { id: memoryId } = await ctx.params
  if (!memoryId) return NextResponse.json({ error: 'memory id required' }, { status: 400 })

  // Confirm the memory belongs to this owner (and fetch its current stats).
  const { data: memory, error: memErr } = await db
    .from('mimir_memories')
    .select('id, content, category, importance, applied_count, last_applied_at, created_at')
    .eq('id', memoryId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (memErr)     return NextResponse.json({ error: memErr.message }, { status: 500 })
  if (!memory)    return NextResponse.json({ error: 'Memory not found' }, { status: 404 })

  // Pull recent briefs that mention this memory id in mimir_notes_applied.
  // Postgres jsonb containment: mimir_notes_applied @> '[{"id":"<uuid>"}]'.
  const { data: briefs, error: briefErr } = await db
    .from('seo_content_briefs')
    .select('id, primary_keyword, page, status, tyr_score, created_at, updated_at, mimir_notes_applied')
    .eq('owner_user_id', ownerId)
    .not('mimir_notes_applied', 'is', null)
    .contains('mimir_notes_applied', [{ id: memoryId }])
    .order('updated_at', { ascending: false })
    .limit(50)

  if (briefErr) {
    return NextResponse.json({
      memory,
      briefs: [],
      error:  briefErr.message,
    }, { status: 200 })
  }

  // Strip mimir_notes_applied from the response — we only needed it for the
  // contains() filter, returning it would bloat the payload.
  const briefSummaries = (briefs ?? []).map(b => ({
    id:               b.id,
    primary_keyword:  b.primary_keyword,
    page:             b.page,
    status:           b.status,
    tyr_score:        b.tyr_score,
    created_at:       b.created_at,
    updated_at:       b.updated_at,
  }))

  return NextResponse.json({
    memory,
    briefs:        briefSummaries,
    total_briefs:  briefSummaries.length,
  })
}
