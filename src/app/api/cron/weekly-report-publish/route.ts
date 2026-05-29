import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { deliverWeeklyReport } from '@/lib/reports/weekly-publisher'

export const maxDuration = 120

/**
 * GET /api/cron/weekly-report-publish
 *
 * Sprint WEEKLY.PUBLIC — Monday 08:00 UTC (15:00 WIB) auto-publish sweep.
 *
 * Logic:
 *   1. Find all weekly_reports rows with publish_status='draft' (or 'approved')
 *      generated in the last 24h
 *   2. For each, apply curatorial_edits (if any) and post to Slack via the
 *      multi-channel routing config
 *   3. Update status to 'auto_published' (if no curatorial_edits) or
 *      'published' (if there were edits)
 *   4. 'held' rows are skipped — Galih marked them as DO NOT SEND
 *
 * Schedule: Monday 08:00 UTC via .github/workflows/weekly-report-publish.yml
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Pull pending drafts from last 24h (covers same-day generator + manual approvals)
  const yesterday = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data: drafts, error } = await db
    .from('weekly_reports')
    .select('id, owner_user_id, site_slug, week_start, week_end, publish_status, public_token, ai_narrative, ai_action_plan, curatorial_edits, report_data, slack_ts')
    .in('publish_status', ['draft', 'approved'])
    .gte('week_start', yesterday.slice(0, 10))
    .order('week_start', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!drafts || drafts.length === 0) {
    return NextResponse.json({ ok: true, message: 'No draft reports to publish.', drafts: 0 })
  }

  let posted   = 0
  let failed   = 0
  const results: Array<{ id: string; site: string; status: 'posted' | 'failed' | 'skipped'; notes: string[] }> = []

  for (const report of drafts) {
    try {
      const wasEdited = !!report.curatorial_edits && Object.keys(report.curatorial_edits).length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await deliverWeeklyReport(db, report as any)
      if (result.ok) {
        const newStatus = wasEdited ? 'published' : 'auto_published'
        await db
          .from('weekly_reports')
          .update({
            publish_status: newStatus,
            published_at:   new Date().toISOString(),
            slack_ts:       result.slack_ts ?? null,
          })
          .eq('id', report.id)
        posted++
        results.push({ id: report.id, site: report.site_slug, status: 'posted', notes: result.notes })
      } else {
        failed++
        results.push({ id: report.id, site: report.site_slug, status: 'failed', notes: result.notes })
      }
    } catch (e) {
      failed++
      results.push({ id: report.id, site: report.site_slug, status: 'failed', notes: [e instanceof Error ? e.message : String(e)] })
    }
  }

  return NextResponse.json({
    ok:     failed === 0,
    drafts: drafts.length,
    posted,
    failed,
    results,
  })
}
