import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runForsetiScraper } from '@/lib/forseti/scraper'

export const maxDuration = 120

/**
 * GET /api/cron/forseti-scraper
 *
 * Sprint FORSETI.SCRAPER — hourly Reddit poll.
 *
 * Iterates all enabled forseti_subreddit_configs across all owners. Fetches
 * /r/[subreddit]/new.json, classifies + scores severity, upserts into
 * forseti_threads while preserving manual overrides. Updates config
 * last_polled_at + status.
 *
 * Auth: Bearer CRON_SECRET. Suggested schedule: every hour at minute 5.
 */
function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServiceClient()
  const results = await runForsetiScraper(db, {})

  // Sprint FORSETI.SLACK.ALERT — fire alerts for sev-4+ inserts. Lazy-imported
  // to keep cold start light when no alerts trigger.
  const alertIds = results.flatMap(r => r.alerts_needed)
  if (alertIds.length > 0) {
    try {
      const { fireForsetiSevereAlerts } = await import('@/lib/forseti/slack')
      await fireForsetiSevereAlerts(db, alertIds)
    } catch (err) {
      console.warn('[forseti-cron] slack alert dispatch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return NextResponse.json({
    ok:       results.every(r => r.ok),
    ran_at:   new Date().toISOString(),
    summary: {
      configs:      results.length,
      fetched:      results.reduce((s, r) => s + r.fetched,  0),
      matched:      results.reduce((s, r) => s + r.matched,  0),
      inserted:     results.reduce((s, r) => s + r.inserted, 0),
      updated:      results.reduce((s, r) => s + r.updated,  0),
      filtered:     results.reduce((s, r) => s + r.filtered, 0),
      alerts_fired: alertIds.length,
    },
    per_config: results,
  })
}
