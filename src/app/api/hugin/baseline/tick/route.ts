import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { runHuginAggregator } from '@/lib/hugin/aggregate'

export const maxDuration = 300

/**
 * POST /api/hugin/baseline/tick
 *
 * Sprint HUGIN.BASELINE.1 — process the next pending week of a baseline run.
 *
 * Body: { run_id: string }
 *
 * Each tick:
 *   1. Pop the next week from pending_weeks
 *   2. Call GSC searchanalytics for that range with dimensions=[page, query]
 *   3. Upsert rows into gsc_query_snapshots
 *   4. Update run: completed_weeks++, total_rows_fetched += N
 *   5. If pending_weeks is now empty → status='aggregating' → run
 *      runHuginAggregator → status='completed'
 *
 * Returns the latest run state so client can decide if next tick is needed.
 *
 * Client (the /hugin progress banner) drives ticks via setInterval until
 * status='completed' or status='failed'.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { run_id?: string }
  const runId = body.run_id
  if (!runId) return NextResponse.json({ error: 'run_id required' }, { status: 400 })

  // Lock-ish: load + verify
  const { data: run, error: loadErr } = await db
    .from('hugin_baseline_runs')
    .select('*')
    .eq('id', runId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!run)    return NextResponse.json({ error: 'Run not found' }, { status: 404 })

  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return NextResponse.json({ ok: true, run, message: `Run already ${run.status}` })
  }

  // Transition to running on first tick
  if (run.status === 'pending') {
    await db.from('hugin_baseline_runs')
      .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', runId)
  }

  const pendingWeeks: Array<{ start: string; end: string }> = Array.isArray(run.pending_weeks) ? run.pending_weeks : []

  // If pending is empty → cascade to aggregator
  if (pendingWeeks.length === 0) {
    return await runAggregatorThenComplete(db, ownerId, runId, run.gsc_property_url as string, run.site_slug as string)
  }

  // Pop one week
  const week     = pendingWeeks[0]
  const remaining = pendingWeeks.slice(1)

  // Load GSC connection + refresh token
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id, site_url, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .eq('site_url', run.gsc_property_url)
    .maybeSingle()
  if (!conn) {
    await db.from('hugin_baseline_runs').update({
      status:        'failed',
      error_message: 'GSC connection no longer exists',
      updated_at:    new Date().toISOString(),
    }).eq('id', runId)
    return NextResponse.json({ ok: false, error: 'GSC connection missing' }, { status: 400 })
  }

  let rowsFetched = 0
  const warningsList: string[] = (Array.isArray(run.warnings) ? run.warnings : []) as string[]

  try {
    const { client: auth, newCredentials } = await getRefreshedClientFull(
      conn.access_token, conn.refresh_token, conn.expires_at,
    )
    if (newCredentials) {
      await db.from('gsc_connections').update({
        access_token: newCredentials.accessToken,
        expires_at:   newCredentials.expiresAt,
      }).eq('user_id', ownerId).eq('site_url', conn.site_url)
    }

    // Fetch the week with dimensions=[page, query], rowLimit 25000
    const rows = await getSearchAnalytics(
      auth,
      conn.site_url,
      week.start,
      week.end,
      ['page', 'query'],
      25000,
    )

    const inserts = (rows ?? [])
      .filter(r => (r.keys?.[1] ?? '').trim().length > 0 && (r.keys?.[0] ?? '').trim().length > 0)
      .map(r => ({
        site_url:      conn.site_url,
        // For weekly aggregates the API returns one row per (page, query) for the whole range.
        // We store with snapshot_date = week's END date so cron and baseline data live in
        // the same table. Aggregator's date-range queries already handle overlapping rows.
        snapshot_date: week.end,
        page:          r.keys?.[0] ?? '',
        query:         (r.keys?.[1] ?? '').toLowerCase().trim().slice(0, 500),
        clicks:        r.clicks      ?? 0,
        impressions:   r.impressions ?? 0,
        ctr:           r.ctr         ?? 0,
        position:      r.position    ?? 0,
      }))

    // Chunked upsert
    for (let i = 0; i < inserts.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      const { error: upErr } = await db
        .from('gsc_query_snapshots')
        .upsert(inserts.slice(i, i + 500), {
          onConflict:       'site_url,snapshot_date,page,query',
          ignoreDuplicates: true,
        })
      if (upErr) {
        warningsList.push(`upsert error week ${week.start}: ${upErr.message}`)
      }
    }
    rowsFetched = inserts.length
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warningsList.push(`GSC fetch ${week.start}..${week.end}: ${msg}`)
    // Skip this week, continue to next. Don't fail the whole run on a single bad week.
  }

  // Update progress
  const newCompleted = (run.completed_weeks as number) + 1
  const newTotalRows = (run.total_rows_fetched as number) + rowsFetched
  const willCompleteFetch = remaining.length === 0

  await db.from('hugin_baseline_runs').update({
    pending_weeks:      remaining,
    completed_weeks:    newCompleted,
    total_rows_fetched: newTotalRows,
    warnings:           warningsList,
    status:             willCompleteFetch ? 'aggregating' : 'running',
    updated_at:         new Date().toISOString(),
  }).eq('id', runId)

  // If that was the last week, immediately cascade aggregator (within this same lambda)
  if (willCompleteFetch) {
    return await runAggregatorThenComplete(db, ownerId, runId, run.gsc_property_url as string, run.site_slug as string)
  }

  // Otherwise return current state, client will poll + tick again
  const { data: updatedRun } = await db
    .from('hugin_baseline_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle()

  return NextResponse.json({
    ok:               true,
    run:              updatedRun,
    week_processed:   week,
    rows_fetched:     rowsFetched,
    remaining_weeks:  remaining.length,
  })
}

// ─── Aggregator cascade ─────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runAggregatorThenComplete(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       any,
  ownerId:  string,
  runId:    string,
  gscUrl:   string,
  siteSlug: string,
): Promise<NextResponse> {
  const aggResult = await runHuginAggregator(db, {
    ownerId,
    siteSlug,
    gscPropertyUrl: gscUrl,
  })

  const completedAt = new Date().toISOString()
  await db.from('hugin_baseline_runs').update({
    status:             aggResult.error ? 'failed' : 'completed',
    aggregator_result:  aggResult,
    error_message:      aggResult.error ?? null,
    completed_at:       completedAt,
    updated_at:         completedAt,
  }).eq('id', runId)

  const { data: finalRun } = await db
    .from('hugin_baseline_runs')
    .select('*')
    .eq('id', runId)
    .maybeSingle()

  return NextResponse.json({
    ok:                 !aggResult.error,
    run:                finalRun,
    aggregator_result:  aggResult,
    cascade_completed:  true,
  })
}
