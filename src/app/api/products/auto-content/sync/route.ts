import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { readProductSheet, isPendingTrigger } from '@/lib/google/sheets'
import { processProductRow, type QueueRow, type SheetTarget } from '@/lib/product-content/process'

export const maxDuration = 300

/**
 * POST /api/products/auto-content/sync
 *
 * "Run All Pending" — sheet-as-database flow (2026-05-12 refactor):
 *   1. Read the Google Sheet
 *   2. Pick rows where col E ("Create now?") = "yes" (case-insensitive)
 *   3. For each: upsert into product_content_queue, run processProductRow
 *   4. processProductRow writes structured content back to sheet (EN + ID tabs)
 *      and updates col E to "Generated" or "Error: <stage-tagged>"
 *
 * No Google Drive doc creation. No cron auto-loop — this is a manual button.
 * Body (optional): { spreadsheet_id?, sheet_name?, limit? }
 */
export async function POST(req: Request) {
  const supabase  = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    spreadsheet_id?: string
    sheet_name?:     string
    limit?:          number
  }

  // ── Load sheet config ─────────────────────────────────────────────────────
  const { data: sheetConfig } = await db
    .from('product_sheet_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .single()

  const spreadsheetId = body.spreadsheet_id ?? sheetConfig?.spreadsheet_id
  const sheetName     = body.sheet_name     ?? sheetConfig?.sheet_name ?? 'Sheet1'
  // Per-run cap. Vercel's 300s timeout fits ~12-15 rows at Haiku speed; keep
  // the cap conservative so a single batch never hits the wall.
  const limit         = body.limit          ?? 12

  if (!spreadsheetId) {
    return NextResponse.json({
      error: 'No spreadsheet configured. Set up Google Sheet first.',
    }, { status: 400 })
  }

  // ── Read every row from the sheet ─────────────────────────────────────────
  let sheetRows
  try {
    sheetRows = await readProductSheet(spreadsheetId, sheetName, 2, 500)
  } catch (e) {
    return NextResponse.json({
      error: `Google Sheets read error: ${e instanceof Error ? e.message : String(e)}`,
    }, { status: 500 })
  }

  // ── Filter to "yes" trigger rows ──────────────────────────────────────────
  const triggerRows = sheetRows.filter(r => isPendingTrigger(r.createNow))

  if (triggerRows.length === 0) {
    // Diagnostic: tell the user EXACTLY why nothing matched
    const totalRows = sheetRows.length
    const alreadyDone = sheetRows.filter(r => r.createNow.toLowerCase().includes('generated')).length
    const erroredRows = sheetRows.filter(r => r.createNow.toLowerCase().startsWith('error')).length
    return NextResponse.json({
      processed: 0,
      message:   totalRows === 0
        ? `Sheet has no data rows. Add product entries starting at row 2.`
        : `Sheet has ${totalRows} rows but none have col E = "yes". ${alreadyDone} already Generated, ${erroredRows} errored.`,
      diagnostics: { totalRows, alreadyDone, erroredRows, sheetName },
    })
  }

  // Cap at per-run limit
  const queue = triggerRows.slice(0, limit)

  // ── Upsert each row into product_content_queue (DB mirror for dashboard) ──
  const queueRows: QueueRow[] = []
  for (const row of queue) {
    const url = `https://www.g2g.com/categories/${row.productName.toLowerCase().replace(/\s+/g, '-')}`

    const { data: existing } = await db
      .from('product_content_queue')
      .select('id')
      .eq('owner_user_id', ownerId)
      .eq('relation_id', row.relationId)
      .maybeSingle()

    let qid: string
    if (existing) {
      qid = existing.id
      await db
        .from('product_content_queue')
        .update({
          product_name: row.productName,
          category:     row.category,
          url,
          sheet_row:    row.rowIndex,
          request_date: row.requestDate || null,
          status:       'generating',
          updated_at:   new Date().toISOString(),
        })
        .eq('id', qid)
    } else {
      const { data: ins } = await db
        .from('product_content_queue')
        .insert({
          owner_user_id: ownerId,
          relation_id:   row.relationId,
          product_name:  row.productName,
          category:      row.category,
          url,
          sheet_row:     row.rowIndex,
          request_date:  row.requestDate || null,
          status:        'generating',
        })
        .select('id')
        .single()
      qid = ins?.id ?? ''
    }

    queueRows.push({
      id:           qid,
      owner_user_id: ownerId,
      relation_id:  row.relationId,
      product_name: row.productName,
      category:     row.category,
      request_date: row.requestDate || null,
      sheet_row:    row.rowIndex,
    })
  }

  // ── Process sequentially (Vercel timeout, but mostly to keep API costs sane) ─
  const sheetTarget: SheetTarget = { spreadsheetId, sheetName }
  const results: Array<{ relation_id: string; ok: boolean; error?: string }> = []

  for (const r of queueRows) {
    const result = await processProductRow(r, db, supabase, sheetTarget)
    results.push({
      relation_id: r.relation_id,
      ok:          result.ok,
      error:       result.error,
    })
  }

  // ── Bookkeeping ────────────────────────────────────────────────────────────
  await db
    .from('product_sheet_config')
    .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.length - succeeded
  const skipped   = Math.max(0, triggerRows.length - queue.length)

  return NextResponse.json({
    processed: results.length,
    succeeded,
    failed,
    skipped,    // rows above limit that we didn't process this run
    results,
    message: skipped > 0
      ? `Processed ${results.length}/${triggerRows.length}. ${skipped} pending — click Run again to continue.`
      : `Processed ${results.length}/${results.length} pending rows.`,
  })
}
