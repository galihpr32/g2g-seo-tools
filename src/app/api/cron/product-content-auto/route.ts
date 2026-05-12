import { NextResponse } from 'next/server'

/**
 * GET /api/cron/product-content-auto
 *
 * DISABLED 2026-05-12 — Product Content moved to a manual-trigger sheet-as-
 * database flow. The "Create now?" col (E) in the sheet is the new trigger;
 * Galih hits "Run All Pending" in the UI when ready, which calls the
 * /api/products/auto-content/sync route.
 *
 * Kept as a no-op so existing GitHub Actions cron schedules don't 404 while
 * we clean up the workflow YAML. To remove fully: delete this file +
 * .github/workflows/product-content-auto.yml.
 *
 * Returns 200 with a clear status note so cron monitoring tools see "OK"
 * instead of "error".
 */
export async function GET(_req: Request) {
  return NextResponse.json({
    ok:       true,
    disabled: true,
    note:     'Auto-process cron disabled. Use "Run All Pending" button in the Product Content UI.',
  })
}
