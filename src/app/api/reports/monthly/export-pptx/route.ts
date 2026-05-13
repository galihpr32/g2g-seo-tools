// ─── Monthly Report → PPTX export ───────────────────────────────────────────
// POST /api/reports/monthly/export-pptx
// Body: { id: string }   — monthly_reports row id
//
// Builds a stakeholder-style PPTX deck and streams it directly to the browser
// as a file download (Content-Disposition: attachment). No Google Drive needed.
//
// Lambda budget: 60s. PPTX generation is fast (≤ 3s for 9 slides).

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildMonthlyReportPptx, type MonthlyReportData } from '@/lib/reports/pptx-builder'
import { NextResponse } from 'next/server'

export const maxDuration = 60

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

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
    .from('monthly_reports')
    .select('id, month_start, month_end, report_data, ai_narrative, ai_action_plan')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (loadErr || !report) {
    return NextResponse.json(
      { error: loadErr?.message ?? 'Report not found' },
      { status: 404 },
    )
  }

  // 2. Build the PPTX in memory
  let buffer: Buffer
  try {
    buffer = await buildMonthlyReportPptx({
      reportData:   report.report_data as MonthlyReportData,
      aiNarrative:  String(report.ai_narrative ?? ''),
      aiActionPlan: String(report.ai_action_plan ?? ''),
    })
  } catch (err) {
    console.error('[export-pptx] build failed:', err)
    return NextResponse.json(
      { error: `PPTX build failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }

  // 3. Build a clean filename
  const r        = report.report_data as MonthlyReportData
  const brand    = (r.siteName ?? r.siteSlug ?? 'Report').replace(/[^a-z0-9 _-]/gi, '')
  const monthFmt = (r.monthLabel ?? `${report.month_start}`).replace(/\s+/g, '-')
  const filename = `${brand} Monthly Report — ${monthFmt}.pptx`

  // 4. Stream the file directly to the browser.
  // Wrap the Node Buffer in a Blob — this is the cleanest BodyInit shape that
  // satisfies Next 16's strict Response typing (Buffer<ArrayBufferLike> and
  // bare Uint8Array both fail TS contextual narrowing because the BodyInit
  // union resolves to URLSearchParams in this Next/Node lib combo).
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
