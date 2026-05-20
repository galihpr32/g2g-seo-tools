import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

/**
 * POST /api/hugin/baseline/start
 *
 * Sprint HUGIN.BASELINE.1 — Enqueue a historical GSC backfill job.
 *
 * Body: { duration_days: 30 | 60 | 90 | 120 | 180 }
 *
 * Builds the list of weekly date ranges to fetch (chunked by 7 days),
 * inserts a hugin_baseline_runs row with status='pending', returns the
 * run_id. Client then polls /api/hugin/baseline/[id] and POSTs to
 * /api/hugin/baseline/tick to process one week at a time.
 *
 * Validation:
 *   • Reject if another run is already pending/running for same (owner × site)
 *   • Reject if no gsc_connections row exists for this owner
 *   • Cap duration at 180 days (~6 months — GSC retains 16 months but
 *     full keyword data degrades after 6mo)
 */

const VALID_DURATIONS = [30, 60, 90, 120, 180] as const
const GSC_LAG_DAYS = 4

function dateAddDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as { duration_days?: number }
  const days = Number(body.duration_days)
  if (!VALID_DURATIONS.includes(days as typeof VALID_DURATIONS[number])) {
    return NextResponse.json({ error: `duration_days must be one of ${VALID_DURATIONS.join(', ')}` }, { status: 400 })
  }

  // 1. Resolve GSC property URL for this site from site_configs (the actual
  // mapping table). gsc_connections is keyed by user_id only — one row per
  // user, shared across sites since OAuth tokens cover all GSC properties
  // under the same Google account.
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('slug, gsc_property')
    .eq('slug', siteSlug)
    .eq('is_active', true)
    .maybeSingle()
  if (!siteConfig?.gsc_property) {
    return NextResponse.json({
      error: `No active site_config for ${siteSlug}. Configure it first at /settings.`,
    }, { status: 400 })
  }

  // 2. Verify the owner actually has OAuth tokens
  const { data: connection } = await db
    .from('gsc_connections')
    .select('user_id, site_url')
    .eq('user_id', ownerId)
    .maybeSingle()
  if (!connection) {
    return NextResponse.json({
      error: `No GSC OAuth connection for this workspace. Connect it first at /settings/google.`,
    }, { status: 400 })
  }

  const gscPropertyUrl = siteConfig.gsc_property as string

  // 3. Block concurrent runs for same (owner × site)
  const { data: active } = await db
    .from('hugin_baseline_runs')
    .select('id, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .in('status',        ['pending', 'running', 'aggregating'])
    .limit(1)
  if (active && active.length > 0) {
    return NextResponse.json({
      error: `Another baseline run is already in progress (id=${active[0].id}). Cancel it first or wait for completion.`,
      conflict_run_id: active[0].id,
    }, { status: 409 })
  }

  // 4. Build the list of weekly windows.
  // end-anchor = today - GSC_LAG_DAYS. We walk back in 7-day chunks until
  // we've covered duration_days days. Last chunk may be shorter than 7
  // days if duration_days % 7 != 0.
  const end0  = dateAddDays(new Date(), -GSC_LAG_DAYS)
  const weeks: Array<{ start: string; end: string }> = []
  let consumed = 0
  while (consumed < days) {
    const remaining = days - consumed
    const chunkLen  = Math.min(7, remaining)
    const chunkEnd  = dateAddDays(end0, -consumed)
    const chunkStart = dateAddDays(chunkEnd, -(chunkLen - 1))
    weeks.push({ start: toIso(chunkStart), end: toIso(chunkEnd) })
    consumed += chunkLen
  }
  // Sort oldest-first so the tick processes chronologically (helps spot
  // partial-failure date ranges in error_message)
  weeks.reverse()

  // 5. Insert run row
  const { data: run, error: insertErr } = await db
    .from('hugin_baseline_runs')
    .insert({
      owner_user_id:    ownerId,
      site_slug:        siteSlug,
      gsc_property_url: gscPropertyUrl,
      duration_days:    days,
      status:           'pending',
      total_weeks:      weeks.length,
      completed_weeks:  0,
      pending_weeks:    weeks,
    })
    .select('id')
    .single()

  if (insertErr || !run) {
    return NextResponse.json({ error: insertErr?.message ?? 'Failed to create run' }, { status: 500 })
  }

  return NextResponse.json({
    ok:                true,
    run_id:            run.id,
    duration_days:     days,
    total_weeks:       weeks.length,
    gsc_property_url:  gscPropertyUrl,
    first_window:      weeks[0],
    last_window:       weeks[weeks.length - 1],
  })
}
