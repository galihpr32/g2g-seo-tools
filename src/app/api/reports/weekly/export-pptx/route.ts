import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildWeeklyReportPptx, type WeeklyReportData } from '@/lib/reports/pptx-builder-weekly'

export const maxDuration = 60

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/**
 * POST /api/reports/weekly/export-pptx
 * Body: { id: string }   — weekly_reports row id
 *
 * Builds a 5-slide stakeholder-style weekly PPTX deck and streams it directly
 * to the browser as a file download. Cover, KPIs, top movers, AI narrative,
 * action plan. Caller-owned upload to Drive happens separately in the cron
 * route (so the same endpoint serves both manual download + auto delivery).
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { id } = await req.json().catch(() => ({})) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // 1. Load the report (ownership check)
  const { data: report, error: loadErr } = await db
    .from('weekly_reports')
    .select('id, week_start, week_end, site_slug, report_data, ai_narrative, ai_action_plan')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (loadErr || !report) {
    return NextResponse.json(
      { error: loadErr?.message ?? 'Report not found' },
      { status: 404 },
    )
  }

  // 2. Adapt stored report_data to WeeklyReportData shape
  const wpd = adaptToWeeklyReportData(report)

  // 3. Build PPTX in memory
  let buffer: Buffer
  try {
    buffer = await buildWeeklyReportPptx({
      reportData:   wpd,
      aiNarrative:  String(report.ai_narrative   ?? ''),
      aiActionPlan: String(report.ai_action_plan ?? ''),
      theme:        report.site_slug === 'offgamers' ? { accent: '2563EB' } : undefined,
    })
  } catch (err) {
    console.error('[weekly export-pptx] build failed:', err)
    return NextResponse.json(
      { error: `PPTX build failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }

  // 4. Filename
  const brand    = (wpd.siteName ?? wpd.siteSlug ?? 'Report').replace(/[^a-z0-9 _-]/gi, '')
  const weekFmt  = (wpd.weekLabel ?? `${report.week_start}`).replace(/\s+/g, '-')
  const filename = `${brand} Weekly Report — ${weekFmt}.pptx`

  // 5. Stream
  const body = new Blob([new Uint8Array(buffer)], { type: PPTX_MIME })
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':        PPTX_MIME,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(buffer.length),
    },
  })
}

/**
 * Map a weekly_reports.report_data JSONB blob into the shape our PPTX builder
 * expects. Tolerates slightly different field names from older rows.
 */
function adaptToWeeklyReportData(report: {
  week_start: string
  week_end:   string
  site_slug:  string
  report_data: unknown
}): WeeklyReportData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rd = (report.report_data ?? {}) as Record<string, any>

  const startFmt = new Date(report.week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endFmt   = new Date(report.week_end)  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return {
    weekStart:   report.week_start,
    weekEnd:     report.week_end,
    weekLabel:   rd.weekLabel ?? `${startFmt}–${endFmt}`,
    prevLabel:   rd.prevWeekLabel ?? 'previous week',
    siteSlug:    report.site_slug,
    siteName:    rd.siteName ?? (report.site_slug === 'offgamers' ? 'OffGamers' : 'G2G'),
    generatedAt: rd.generatedAt ?? new Date().toISOString(),
    gsc:         rd.gsc ?? null,
  }
}
