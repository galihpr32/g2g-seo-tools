import { NextResponse }       from 'next/server'
import { createClient }       from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData } from '@/lib/workspace'
import { reviewSingleBrief }  from '@/lib/agents/tyr'

/**
 * POST /api/content/briefs/[id]/tyr-review
 *
 * Run Tyr's quality review on a single brief by ID.
 * Called from the BriefActionBar when the user clicks "Run Tyr Review"
 * or "Re-run Tyr" — no agent_runs row needed since this is a targeted
 * on-demand call, not a batch sweep.
 *
 * Writes score + breakdown directly to seo_content_briefs and returns
 * { score, tyrStatus, breakdown } for optimistic UI update.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // Resolve ownership via the brief itself (legacy briefs may have been
  // stamped with the writer's user_id rather than the workspace owner's).
  const db = createServiceClient()
  const { data: briefMeta } = await db
    .from('seo_content_briefs')
    .select('owner_user_id')
    .eq('id', id)
    .maybeSingle()
  if (!briefMeta) return NextResponse.json({ ok: false, error: 'Brief not found' }, { status: 404 })

  const ownerId = String(briefMeta.owner_user_id)
  const allowed = await canAccessOwnerData(supabase, user.id, ownerId)
  if (!allowed) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  try {
    const result = await reviewSingleBrief(id, ownerId)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[tyr-review]', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
