// ─── Monthly Report → PPTX export ───────────────────────────────────────────
// POST /api/reports/monthly/export-pptx
// Body: { id: string }   — monthly_reports row id
//
// Reads the saved monthly report, builds a stakeholder-style PPTX deck
// (G2G branded — dark + red), uploads it to Google Drive
// (GOOGLE_DRIVE_FOLDER_ID), and returns a shareable view link.
//
// Why save to Drive (not download direct):
//   • Persists alongside other team docs (Product Content already lives there)
//   • Survives session — link can be reopened, shared, embedded in emails
//   • Avoids streaming a 1-3 MB binary through Vercel's response (lambda
//     timeouts and gateway limits are kinder to small JSON than big files)
//
// Lambda budget: 60s. PPTX generation is fast (≤ 3s for 9 slides), Drive
// upload is the long pole (~5-10s).

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { uploadFileToDrive } from '@/lib/google/drive'
import { buildMonthlyReportPptx, type MonthlyReportData } from '@/lib/reports/pptx-builder'

export const maxDuration = 60

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { id } = await req.json().catch(() => ({})) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // 1. Load the report (RLS check — must be the owner's row)
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

  // 3. Upload to Drive
  const r        = report.report_data as MonthlyReportData
  const slug     = (r.siteSlug ?? 'site').replace(/[^a-z0-9-]/gi, '-')
  const monthFmt = (r.monthLabel ?? `${report.month_start}–${report.month_end}`).replace(/\s+/g, '-')
  const filename = `[G2G] Monthly Report — ${slug} — ${monthFmt}.pptx`

  let uploaded
  try {
    uploaded = await uploadFileToDrive(
      buffer,
      filename,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      { makePublic: true },
    )
  } catch (err) {
    console.error('[export-pptx] drive upload failed:', err)
    return NextResponse.json(
      { error: `Drive upload failed: ${err instanceof Error ? err.message : String(err)}. Check GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY + GOOGLE_DRIVE_FOLDER_ID env vars.` },
      { status: 500 },
    )
  }

  // 4. Persist link on the report row so we don't regenerate next time
  await db
    .from('monthly_reports')
    .update({
      pptx_drive_id:    uploaded.id,
      pptx_drive_url:   uploaded.webViewLink,
      pptx_generated_at: new Date().toISOString(),
    })
    .eq('id', report.id)
    .then(() => { /* silent */ }, err => {
      // Non-fatal — the columns might not exist yet (migration optional).
      // Log it but still return the link to the user.
      console.warn('[export-pptx] persist link failed (non-fatal):', err)
    })

  return NextResponse.json({
    ok:        true,
    fileId:    uploaded.id,
    url:       uploaded.webViewLink,
    filename,
    sizeBytes: buffer.length,
  })
}
