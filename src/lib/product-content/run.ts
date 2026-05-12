import type { SupabaseClient } from '@supabase/supabase-js'
import { readProductSheet, isPendingTrigger, getSheetColumnMap } from '@/lib/google/sheets'
import { processProductRow, type QueueRow, type SheetTarget } from './process'

/**
 * Shared "Run All Pending" driver — used by:
 *   • /api/products/auto-content/sync   (manual button click)
 *   • /api/cron/product-content-auto    (5-min scheduled cron)
 *
 * Both paths share this code so the manual button and the auto-cron stay
 * behaviour-identical: same trigger detection (col E = "yes"), same DB
 * upsert, same write-back, same error semantics.
 *
 * Concurrency: when a row already has `status='generating'` updated within
 * STALE_LOCK_MIN minutes, we skip it. This prevents the cron from
 * double-processing a row that the user just kicked off manually (and
 * vice-versa).
 */

const STALE_LOCK_MIN = 3   // a manual run that's actively generating shouldn't be raced by the next cron tick

export interface RunResult {
  processed: number
  succeeded: number
  failed:    number
  skipped:   number
  /** Rows present in the sheet with col E = "yes" but currently locked by a
   *  concurrent run. They'll be picked up by the next pass. */
  locked:    number
  results:   Array<{ relation_id: string; ok: boolean; error?: string }>
  /** Diagnostic for the UI when no work was found. */
  diagnostics?: {
    totalRows:    number
    alreadyDone:  number
    erroredRows:  number
    sheetName:    string
  }
}

const EMPTY: RunResult = { processed: 0, succeeded: 0, failed: 0, skipped: 0, locked: 0, results: [] }

export async function runPendingForOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  ownerId:  string,
  options:  { limit?: number; spreadsheetIdOverride?: string; sheetNameOverride?: string } = {},
): Promise<RunResult & { ok: true } | { ok: false; error: string }> {
  // ── Load sheet config ────────────────────────────────────────────────────
  const { data: sheetConfig } = await db
    .from('product_sheet_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .single()

  const spreadsheetId = options.spreadsheetIdOverride ?? sheetConfig?.spreadsheet_id
  const sheetName     = options.sheetNameOverride     ?? sheetConfig?.sheet_name ?? 'Sheet1'
  // Vercel function ceiling is 300s; ~20s/row at Haiku speed → 12 fits comfortably.
  const limit         = options.limit ?? 12

  if (!spreadsheetId) {
    return { ok: false, error: 'No spreadsheet configured for this owner.' }
  }

  // ── Read every row ───────────────────────────────────────────────────────
  let sheetRows
  try {
    sheetRows = await readProductSheet(spreadsheetId, sheetName, 2, 500)
  } catch (e) {
    return { ok: false, error: `Google Sheets read error: ${e instanceof Error ? e.message : String(e)}` }
  }

  // ── Filter to "yes" trigger rows ─────────────────────────────────────────
  const triggerRows = sheetRows.filter(r => isPendingTrigger(r.createNow))

  if (triggerRows.length === 0) {
    const totalRows   = sheetRows.length
    const alreadyDone = sheetRows.filter(r => r.createNow.toLowerCase().includes('generated')).length
    const erroredRows = sheetRows.filter(r => r.createNow.toLowerCase().startsWith('error')).length
    return {
      ok: true, ...EMPTY,
      diagnostics: { totalRows, alreadyDone, erroredRows, sheetName },
    }
  }

  // ── Resolve column map once (for header-aware writes) ───────────────────
  let colMap: Record<string, number> | undefined
  try {
    const headerInfo = await getSheetColumnMap(spreadsheetId, sheetName)
    colMap = headerInfo.colMap
  } catch (e) {
    console.warn('[run] getSheetColumnMap failed — falling back to canonical positions:', e)
  }

  // Cap by per-run limit
  const candidates = triggerRows.slice(0, limit)
  const skipped    = Math.max(0, triggerRows.length - candidates.length)

  // ── Concurrency lock: skip rows that another run is currently working on ─
  const cutoffIso = new Date(Date.now() - STALE_LOCK_MIN * 60_000).toISOString()
  const relIds = candidates.map(r => r.relationId)
  const { data: lockedRows } = await db
    .from('product_content_queue')
    .select('relation_id')
    .eq('owner_user_id', ownerId)
    .in('relation_id', relIds)
    .eq('status', 'generating')
    .gt('updated_at', cutoffIso)
  const lockedSet = new Set((lockedRows ?? []).map(r => r.relation_id))

  const queue: QueueRow[] = []
  for (const row of candidates) {
    if (lockedSet.has(row.relationId)) continue

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

    queue.push({
      id:            qid,
      owner_user_id: ownerId,
      relation_id:   row.relationId,
      product_name:  row.productName,
      category:      row.category,
      request_date:  row.requestDate || null,
      sheet_row:     row.rowIndex,
    })
  }

  // ── Process sequentially (preserves Vercel timeout + API rate-limit headroom)
  const sheetTarget: SheetTarget = { spreadsheetId, sheetName, colMap }
  const results: Array<{ relation_id: string; ok: boolean; error?: string }> = []
  for (const r of queue) {
    const result = await processProductRow(r, db, supabase, sheetTarget)
    results.push({ relation_id: r.relation_id, ok: result.ok, error: result.error })
  }

  // ── Bookkeeping: tag last_synced_at so the UI shows freshness ────────────
  await db
    .from('product_sheet_config')
    .update({ last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)

  const succeeded = results.filter(r => r.ok).length
  const failed    = results.length - succeeded

  return {
    ok:        true,
    processed: results.length,
    succeeded,
    failed,
    skipped,
    locked:    lockedSet.size,
    results,
  }
}
