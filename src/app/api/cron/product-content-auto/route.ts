import { NextResponse, after } from 'next/server'
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
 * RESPONSE TIMING — important for free cron schedulers:
 *   The HTTP response returns within ~1s (just "scheduled" status). The
 *   actual processing runs via Vercel's after() hook, which executes AFTER
 *   the response is sent but still within the function's 300s window.
 *
 *   Why: cron-job.org free tier and similar schedulers have a 30s HTTP
 *   timeout. Our per-row processing (Haiku + DataForSEO + sheet writes) is
 *   ~30-50s, so synchronous response would falsely look "Failed (timeout)"
 *   even though work completed server-side. after() decouples the HTTP
 *   round-trip from the work, fixing the false-failure UX.
 *
 * Same code path (runPendingForOwner) is invoked by:
 *   • /api/products/auto-content/sync   (manual click — keeps sync response)
 *   • /api/cron/product-content-auto    (this — every 5 min)
 *
 * Concurrency between manual + cron is handled inside runPendingForOwner via
 * a 3-minute stale-lock check.
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

  // Per-owner cap kept small so a multi-owner cron doesn't blow past
  // Vercel's 300s ceiling. Heavy backlogs naturally drain over the next few
  // 5-minute ticks.
  const PER_OWNER_LIMIT = 8

  // Schedule the actual processing AFTER the HTTP response. The cron caller
  // (cron-job.org) sees a fast 200 OK and won't time out at 30s. Work
  // continues in the same function context for up to maxDuration=300s.
  after(async () => {
    for (const cfg of owners) {
      try {
        const result = await runPendingForOwner(db, db, cfg.owner_user_id, {
          limit: PER_OWNER_LIMIT,
        })
        if (result.ok) {
          console.log(`[cron] owner ${cfg.owner_user_id}: processed ${result.processed} (ok=${result.succeeded}, fail=${result.failed}, locked=${result.locked})`)
        } else {
          console.warn(`[cron] owner ${cfg.owner_user_id} skipped: ${result.error}`)
        }
      } catch (e) {
        console.error(`[cron] owner ${cfg.owner_user_id} threw:`, e)
      }
    }
  })

  return NextResponse.json({
    ok:        true,
    scheduled: true,
    owners:    owners.length,
    note:      `Processing ${owners.length} owner${owners.length === 1 ? '' : 's'} in the background. Check Vercel function logs for per-owner results.`,
  })
}
