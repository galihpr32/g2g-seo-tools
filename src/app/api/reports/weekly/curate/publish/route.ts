import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const maxDuration = 30

/**
 * POST /api/reports/weekly/curate/publish
 * POST /api/reports/weekly/curate/hold
 *
 * Sprint WEEKLY.PUBLIC — manual control over auto-publish flow.
 *
 *  /publish  — Force-publish a draft NOW (post Slack with current edits)
 *  /hold     — Mark draft as 'held' so 08:00 UTC publisher skips it
 *
 * Body: { id: string, action?: 'publish'|'hold' }   (action defaults from URL)
 */

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { id?: string; action?: 'publish' | 'hold' }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // Resolve action from URL path if not in body
  const path = new URL(req.url).pathname
  const action = body.action ?? (path.endsWith('/hold') ? 'hold' : 'publish')

  const db = createServiceClient()

  if (action === 'hold') {
    const { data, error } = await db
      .from('weekly_reports')
      .update({ publish_status: 'held' })
      .eq('id', body.id)
      .select('id, publish_status')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, report: data })
  }

  // publish action — call the deliverer which composes the Slack message
  // and posts it. We import the delivery helper from the cron module so
  // logic stays in one place.
  const { deliverWeeklyReport } = await import('@/lib/reports/weekly-publisher')
  const { data: report } = await db
    .from('weekly_reports')
    .select('*')
    .eq('id', body.id)
    .single()
  if (!report) return NextResponse.json({ error: 'Report not found' }, { status: 404 })

  try {
    const result = await deliverWeeklyReport(db, report)
    await db
      .from('weekly_reports')
      .update({
        publish_status: 'published',
        published_at:   new Date().toISOString(),
        slack_ts:       result.slack_ts ?? null,
      })
      .eq('id', body.id)
    return NextResponse.json({ ...result, ok: true })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
