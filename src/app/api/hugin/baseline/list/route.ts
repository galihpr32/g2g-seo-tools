import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/hugin/baseline/list
 *
 * Sprint HUGIN.BASELINE.1 — list recent baseline runs for the current owner +
 * site. Used by /hugin to restore in-flight progress banner when the page
 * reloads mid-job (don't lose visibility just because user navigated away).
 *
 * Query params:
 *   active=1   — return only pending/running/aggregating
 *   limit=N    — default 20
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { searchParams } = new URL(req.url)
  const activeOnly = searchParams.get('active') === '1'
  const limit      = Math.min(50, parseInt(searchParams.get('limit') ?? '20', 10) || 20)

  let query = db
    .from('hugin_baseline_runs')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (activeOnly) query = query.in('status', ['pending', 'running', 'aggregating'])

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ runs: data ?? [] })
}
