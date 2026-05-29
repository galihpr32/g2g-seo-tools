import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { canAccessOwnerData } from '@/lib/workspace'

export const maxDuration = 10

/**
 * GET /api/mimir/onpage/learn/[id]
 *
 * Sprint MIMIR.ONPAGE — Poll a learner job's status. Returns the live
 * progress row so the UI can drive its progress bar + per-dimension
 * accordions. 2-second polling interval is fine; rows are tiny.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createServiceClient()
  const { data: job, error } = await db
    .from('mimir_onpage_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!job)  return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  // Authz — job must belong to a workspace the caller can access
  const allowed = await canAccessOwnerData(supabase, user.id, String(job.owner_user_id))
  if (!allowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const progressPct = job.total_steps > 0
    ? Math.round((job.completed_steps / job.total_steps) * 100)
    : 0

  return NextResponse.json({
    ok:                true,
    id:                job.id,
    status:            job.status,
    page_count:        job.page_count,
    dimensions:        job.dimensions,
    replace_strategy:  job.replace_strategy,
    total_steps:       job.total_steps,
    completed_steps:   job.completed_steps,
    current_dimension: job.current_dimension,
    progress_pct:      progressPct,
    total_inserted:    job.total_inserted,
    total_deleted:     job.total_deleted,
    per_dimension:     job.per_dimension,
    error_message:     job.error_message,
    created_at:        job.created_at,
    started_at:        job.started_at,
    completed_at:      job.completed_at,
  })
}
