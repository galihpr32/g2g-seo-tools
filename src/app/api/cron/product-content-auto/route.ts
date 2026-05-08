import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { processProductRow, recoverStuckRows, type QueueRow, type SheetTarget } from '@/lib/product-content/process'

export const maxDuration = 300

/**
 * GET /api/cron/product-content-auto
 *
 * Background processor for product content queue. Runs every 5 minutes.
 *
 * Per run:
 *  1. Recover stuck rows (status='generating' >10 min → 'pending')
 *  2. For each owner that has product_sheet_config rows:
 *      a. Pick top N pending rows
 *      b. Mark them 'generating'
 *      c. Process via shared lib (EN content + ID translation + Drive docs)
 *      d. Sheet write-back if config has a spreadsheet_id
 *
 * Batch size: 8 per owner per run (~120s at 12-15s/row, fits within Vercel
 * 300s ceiling with headroom for sheet+drive latency spikes).
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

const BATCH_PER_OWNER = 8

export async function GET(req: Request) {
  if (!isCronAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // 1. Recover any stuck rows globally before picking up new work
  const recovered = await recoverStuckRows(db)

  // 2. Find owners with active sheet configs (auto_generate=true)
  const { data: configs, error: configErr } = await db
    .from('product_sheet_config')
    .select('owner_user_id, spreadsheet_id, sheet_name, auto_generate')
    .eq('auto_generate', true)

  if (configErr) {
    return NextResponse.json({ error: configErr.message, recovered }, { status: 500 })
  }

  // Edge case: also process owners who DON'T have a sheet config but have
  // pending rows (e.g. CSV-imported only). Find those owners too.
  const { data: extraOwners } = await db
    .from('product_content_queue')
    .select('owner_user_id')
    .eq('status', 'pending')
    .limit(50)

  const knownOwners = new Set((configs ?? []).map(c => c.owner_user_id as string))
  const csvOnlyOwners = Array.from(new Set(
    (extraOwners ?? [])
      .map(r => r.owner_user_id as string)
      .filter(o => !knownOwners.has(o))
  ))

  type OwnerWork = { ownerId: string; sheet: SheetTarget | null }
  const workQueue: OwnerWork[] = [
    ...(configs ?? []).map(c => ({
      ownerId: String(c.owner_user_id),
      sheet:   c.spreadsheet_id ? { spreadsheetId: String(c.spreadsheet_id), sheetName: String(c.sheet_name ?? 'Sheet1') } : null,
    })),
    ...csvOnlyOwners.map(o => ({ ownerId: o, sheet: null })),
  ]

  if (workQueue.length === 0) {
    return NextResponse.json({ ok: true, recovered, processed: 0, ownersScanned: 0 })
  }

  const stats = {
    recovered,
    ownersScanned: workQueue.length,
    processed: 0,
    succeeded: 0,
    failed:    0,
    warnings:  [] as string[],
    perOwner:  [] as Array<{ ownerId: string; pickedUp: number; succeeded: number; failed: number }>,
  }

  for (const work of workQueue) {
    // Pick the next batch
    const { data: pendingRows, error: pendErr } = await db
      .from('product_content_queue')
      .select('id, owner_user_id, relation_id, product_name, category, url, sheet_row, main_keyword, secondary_keywords')
      .eq('owner_user_id', work.ownerId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(BATCH_PER_OWNER)

    if (pendErr) {
      stats.warnings.push(`[${work.ownerId}] fetch failed: ${pendErr.message}`)
      stats.perOwner.push({ ownerId: work.ownerId, pickedUp: 0, succeeded: 0, failed: 0 })
      continue
    }

    const batch = (pendingRows ?? []) as QueueRow[]
    if (batch.length === 0) {
      stats.perOwner.push({ ownerId: work.ownerId, pickedUp: 0, succeeded: 0, failed: 0 })
      continue
    }

    // Mark them 'generating' so concurrent cron runs (race) don't double-process.
    // updated_at gets bumped — `recoverStuckRows` uses this to detect stalls.
    const ids = batch.map(r => r.id)
    await db
      .from('product_content_queue')
      .update({ status: 'generating', updated_at: new Date().toISOString() })
      .in('id', ids)

    // Process sequentially. Cost guard: if a single row eats >60s, we still
    // have headroom under the 300s function ceiling for the rest.
    let succ = 0
    let fail = 0
    for (const row of batch) {
      const result = await processProductRow(row, db, db, work.sheet).catch(err => ({
        ok:    false,
        error: err instanceof Error ? err.message : String(err),
      }))
      stats.processed++
      if (result.ok) {
        succ++
        stats.succeeded++
      } else {
        fail++
        stats.failed++
        if (result.error) stats.warnings.push(`[${work.ownerId}/${row.relation_id}] ${result.error}`)
      }
    }
    stats.perOwner.push({ ownerId: work.ownerId, pickedUp: batch.length, succeeded: succ, failed: fail })
  }

  return NextResponse.json({ ok: stats.failed === 0, when: new Date().toISOString(), stats })
}
