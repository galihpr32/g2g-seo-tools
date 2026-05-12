import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { processProductRow, type QueueRow, type SheetTarget } from '@/lib/product-content/process'
import { getSheetColumnMap } from '@/lib/google/sheets'

export const maxDuration = 60

/**
 * POST /api/products/auto-content/process-row
 *
 * Process a single queue row on demand. Three modes:
 *
 *   { ids: ['uuid-1', 'uuid-2', ...] }
 *     — process specific queue row IDs (multi-select bulk action)
 *
 *   { relation_ids: ['rel-1', 'rel-2', ...] }
 *     — process by relation_id (alternative selector)
 *
 *   { all_pending: true, limit?: 10 }
 *     — process the next batch of pending rows (manual "process now" trigger
 *       that complements the cron without waiting for the next 5-min tick).
 *
 * Used by the per-row "Generate" button + multi-select bulk action in the UI.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    ids?:          string[]
    relation_ids?: string[]
    all_pending?:  boolean
    limit?:        number
  }

  // Resolve which rows to process. The processProductRow API now fetches
  // keywords from DataForSEO itself, so we no longer need to carry
  // main_keyword / secondary_keywords on the row.
  let rowsQuery = db
    .from('product_content_queue')
    .select('id, owner_user_id, relation_id, product_name, category, sheet_row, request_date')
    .eq('owner_user_id', ownerId)

  if (body.ids?.length) {
    rowsQuery = rowsQuery.in('id', body.ids)
  } else if (body.relation_ids?.length) {
    rowsQuery = rowsQuery.in('relation_id', body.relation_ids)
  } else if (body.all_pending) {
    const limit = Math.min(Math.max(body.limit ?? 10, 1), 20)
    rowsQuery = rowsQuery.eq('status', 'pending').order('created_at', { ascending: true }).limit(limit)
  } else {
    return NextResponse.json({ error: 'Provide ids[] or relation_ids[] or { all_pending: true }' }, { status: 400 })
  }

  const { data: rows, error: fetchErr } = await rowsQuery
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })

  const queue = (rows ?? []) as QueueRow[]
  if (queue.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No matching rows' })
  }

  // Lookup sheet config so we can write back to D-I columns
  const { data: sheetConfig } = await db
    .from('product_sheet_config')
    .select('spreadsheet_id, sheet_name')
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  let sheet: SheetTarget | null = null
  if (sheetConfig?.spreadsheet_id) {
    const spreadsheetId = String(sheetConfig.spreadsheet_id)
    const sheetName     = String(sheetConfig.sheet_name ?? 'Sheet1')
    let colMap: Record<string, number> | undefined
    try {
      const headerInfo = await getSheetColumnMap(spreadsheetId, sheetName)
      colMap = headerInfo.colMap
    } catch (e) {
      console.warn('[process-row] getSheetColumnMap failed — using canonical positions:', e)
    }
    sheet = { spreadsheetId, sheetName, colMap }
  }

  // Mark all picked rows 'generating' so the cron's recovery logic doesn't
  // also pick them up. updated_at is bumped so a 10-min-later cron sweep
  // won't reset them while we're still working.
  const ids = queue.map(r => r.id)
  await db
    .from('product_content_queue')
    .update({ status: 'generating', updated_at: new Date().toISOString() })
    .in('id', ids)

  // Process sequentially. Function ceiling is 60s — this caps practical
  // batch size at ~5-7 rows. UI should chunk multi-select submissions
  // accordingly (or rely on cron for the rest).
  const results: Array<{ id: string; relation_id: string; ok: boolean; error?: string }> = []
  for (const row of queue) {
    const r = await processProductRow(row, db, db, sheet).catch(err => ({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }))
    results.push({ id: row.id, relation_id: row.relation_id, ok: r.ok, error: r.error })
  }

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.length - succeeded

  return NextResponse.json({
    ok: failed === 0,
    processed: results.length,
    succeeded,
    failed,
    results,
  })
}
