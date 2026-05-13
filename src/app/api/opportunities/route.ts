import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * GET /api/opportunities
 * Returns seo_opportunities for the authenticated user.
 *
 * Query params:
 *   status  = new | in_review | brief_queued | brief_ready | published | dismissed | all (default: excludes dismissed)
 *   site    = site slug (default: g2g)
 *   sort    = signal_count | total_sv | updated_at (default: updated_at)
 *   limit   = number (default 100)
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(request.url)
  const status   = searchParams.get('status')   ?? 'active'   // 'active' = all except dismissed
  const siteSlug = resolveSiteSlugFromRequest(request)
  const sortBy   = searchParams.get('sort')      ?? 'updated_at'
  const limitVal = Math.min(parseInt(searchParams.get('limit') ?? '100'), 500)

  let query = db
    .from('seo_opportunities')
    .select(`
      id, topic, topic_slug, target_url, status, output_type,
      signal_count, total_sv, created_at, updated_at, last_signal_at,
      brief_id, tyr_score, tyr_status,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .eq('site_slug', siteSlug)

  if (status === 'active') {
    query = query.neq('status', 'dismissed')
  } else if (status !== 'all') {
    query = query.eq('status', status)
  }

  const sortAsc  = false
  const sortCol  = ['signal_count', 'total_sv', 'updated_at', 'last_signal_at'].includes(sortBy) ? sortBy : 'updated_at'
  query = query.order(sortCol, { ascending: sortAsc }).limit(limitVal)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ opportunities: data ?? [] })
}

/**
 * PATCH /api/opportunities
 * Update status or output_type on one or more opportunities.
 *
 * Body: { ids: string[], status?: string, output_type?: string }
 */
export async function PATCH(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json() as {
    ids:          string[]
    status?:      string
    output_type?: string
  }

  if (!body.ids?.length) {
    return NextResponse.json({ error: 'ids required' }, { status: 400 })
  }

  const VALID_STATUSES = ['new', 'in_review', 'brief_queued', 'brief_ready', 'published', 'dismissed']
  if (body.status && !VALID_STATUSES.includes(body.status)) {
    return NextResponse.json({ error: `Invalid status "${body.status}"` }, { status: 400 })
  }

  const nowIso = new Date().toISOString()
  const update: Record<string, unknown> = { updated_at: nowIso }
  if (body.status)      update.status      = body.status
  if (body.output_type !== undefined) update.output_type = body.output_type

  // Capture actor on dismiss/approve transitions for audit + reporting.
  if (body.status === 'dismissed') {
    update.dismissed_by = user.id
    update.dismissed_at = nowIso
  }
  if (body.status === 'brief_queued') {
    update.approved_by = user.id
    update.approved_at = nowIso
  }

  const { error } = await db
    .from('seo_opportunities')
    .update(update)
    .in('id', body.ids)
    .eq('owner_user_id', effectiveOwnerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
