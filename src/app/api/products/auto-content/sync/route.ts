import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runPendingForOwner } from '@/lib/product-content/run'

export const maxDuration = 300

/**
 * POST /api/products/auto-content/sync
 *
 * "Run All Pending" — manual button trigger (kept alive alongside the 5-min
 * auto cron at /api/cron/product-content-auto). Both paths share the same
 * runPendingForOwner driver, so the manual click and the scheduled cron
 * behave identically.
 *
 * Body (optional): { spreadsheet_id?, sheet_name?, limit? }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    spreadsheet_id?: string
    sheet_name?:     string
    limit?:          number
  }

  const result = await runPendingForOwner(db, supabase, ownerId, {
    limit:                body.limit,
    spreadsheetIdOverride: body.spreadsheet_id,
    sheetNameOverride:     body.sheet_name,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  // Diagnostic message: nothing to do
  if (result.processed === 0 && result.diagnostics) {
    const d = result.diagnostics
    return NextResponse.json({
      processed: 0, succeeded: 0, failed: 0, skipped: 0, locked: 0,
      message: d.totalRows === 0
        ? `Sheet has no data rows. Add product entries starting at row 2 (or row 3 if a "Path" annotation row is present).`
        : `Sheet has ${d.totalRows} rows but none have col E = "yes". ${d.alreadyDone} already Generated, ${d.erroredRows} errored.`,
      diagnostics: d,
    })
  }

  // Successful run summary
  const tail = result.skipped > 0
    ? ` ${result.skipped} pending beyond per-run limit — they'll be picked up by the next auto-cron (every 5 min) or click Run again.`
    : ''
  const lockedMsg = result.locked > 0
    ? ` ${result.locked} row(s) were locked by a concurrent run and skipped this time.`
    : ''

  return NextResponse.json({
    processed: result.processed,
    succeeded: result.succeeded,
    failed:    result.failed,
    skipped:   result.skipped,
    locked:    result.locked,
    results:   result.results,
    message:   `Processed ${result.processed} pending rows (${result.succeeded} ok, ${result.failed} failed).${tail}${lockedMsg}`,
  })
}
