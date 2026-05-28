import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

/**
 * GET /api/priority-products/run-baseline/status?id=<run_id>
 *   OR
 * GET /api/priority-products/run-baseline/status        (returns active run for owner × site)
 *
 * Sprint SERP.CHUNKED — UI polls this every 2-3 seconds while a run is in
 * progress to render the progress bar. Returns the same shape as /tick
 * minus the just_* fields.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const id = new URL(req.url).searchParams.get('id')

  let q = db
    .from('serp_baseline_runs')
    .select('id, site_slug, scope, status, total_pairs, processed_pairs, failed_pairs, started_at, last_tick_at, completed_at, notes')
    .eq('owner_user_id', ownerId)

  if (id) {
    q = q.eq('id', id).limit(1)
  } else {
    // Latest run for this site (active or done — UI may want to show last completion)
    q = q.eq('site_slug', siteSlug).order('started_at', { ascending: false }).limit(1)
  }

  const { data, error } = await q.maybeSingle()
  if (error)  return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ run: null })

  const remaining = Math.max(0, data.total_pairs - data.processed_pairs - data.failed_pairs)
  const percent   = data.total_pairs > 0 ? Math.round((data.processed_pairs / data.total_pairs) * 100) : 0

  return NextResponse.json({
    run: {
      ...data,
      remaining,
      percent,
    },
  })
}
