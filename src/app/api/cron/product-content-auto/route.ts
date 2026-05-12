import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runPendingForOwner } from '@/lib/product-content/run'

export const maxDuration = 300

/**
 * GET /api/cron/product-content-auto
 *
 * 5-minute background processor for the sheet-as-database flow. Iterates
 * every owner that has a product_sheet_config row, and runs the same
 * "scan col E == 'yes' → process" loop as the manual Run All Pending button.
 *
 * Same code path (runPendingForOwner) is invoked by:
 *   • /api/products/auto-content/sync   (manual click)
 *   • /api/cron/product-content-auto    (this — every 5 min)
 *
 * Concurrency between manual + cron is handled inside runPendingForOwner via
 * a 3-minute stale-lock check: rows currently in `status='generating'` whose
 * updated_at is recent get skipped so the user's manual run isn't doubled.
 *
 * Schedule: every 5 minutes via .github/workflows/product-content-auto.yml.
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

  // Find all owners that have a sheet configured.
  const { data: configs } = await db
    .from('product_sheet_config')
    .select('owner_user_id, spreadsheet_id, sheet_name')
    .not('spreadsheet_id', 'is', null)

  if (!configs || configs.length === 0) {
    return NextResponse.json({ ok: true, message: 'No sheet configs — nothing to process.' })
  }

  const owners = (configs ?? []) as Array<{ owner_user_id: string; spreadsheet_id: string; sheet_name: string | null }>
  const perOwner: Record<string, { processed: number; succeeded: number; failed: number; skipped: number; locked: number }> = {}
  let totalProcessed = 0
  let totalSucceeded = 0
  let totalFailed    = 0

  // Per-owner cap kept small so a multi-owner cron doesn't blow past
  // Vercel's 300s ceiling. Heavy backlogs naturally drain over the next few
  // 5-minute ticks.
  const PER_OWNER_LIMIT = 8

  for (const cfg of owners) {
    try {
      // For the cron path we use the service-role client as BOTH "db" and
      // "supabase" — no per-user auth to call. Service role has full access
      // and bypasses RLS.
      const result = await runPendingForOwner(db, db, cfg.owner_user_id, {
        limit: PER_OWNER_LIMIT,
      })

      if (result.ok) {
        perOwner[cfg.owner_user_id] = {
          processed: result.processed,
          succeeded: result.succeeded,
          failed:    result.failed,
          skipped:   result.skipped,
          locked:    result.locked,
        }
        totalProcessed += result.processed
        totalSucceeded += result.succeeded
        totalFailed    += result.failed
      } else {
        perOwner[cfg.owner_user_id] = { processed: 0, succeeded: 0, failed: 0, skipped: 0, locked: 0 }
        console.warn(`[cron] owner ${cfg.owner_user_id} skipped: ${result.error}`)
      }
    } catch (e) {
      console.error(`[cron] owner ${cfg.owner_user_id} threw:`, e)
    }
  }

  return NextResponse.json({
    ok: true,
    owners:    owners.length,
    processed: totalProcessed,
    succeeded: totalSucceeded,
    failed:    totalFailed,
    perOwner,
  })
}
