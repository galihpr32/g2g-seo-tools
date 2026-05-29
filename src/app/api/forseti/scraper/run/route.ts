import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runForsetiScraper } from '@/lib/forseti/scraper'

export const maxDuration = 60

/**
 * POST /api/forseti/scraper/run
 *
 * Sprint FORSETI.SCRAPER — manual fetch trigger.
 *
 * Body: { subreddit?: string }
 *   • If subreddit set → fetch just that one config (used by per-sub "Fetch
 *     now" button on /forseti/settings).
 *   • If empty        → fetch all enabled configs for this owner (used by
 *     "Run all scrapers now" button on /forseti).
 *
 * Scoped to caller's owner_id — won't bleed across workspaces.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { subreddit?: string }
  const subreddit = body.subreddit?.trim() || undefined

  const results = await runForsetiScraper(db, { ownerId, subreddit })

  // Sprint FORSETI.SLACK.ALERT — fire alerts for sev-4+ inserts (also from
  // manual runs, since manual is sometimes the first scrape of a new sub).
  const alertIds = results.flatMap(r => r.alerts_needed)
  if (alertIds.length > 0) {
    try {
      const { fireForsetiSevereAlerts } = await import('@/lib/forseti/slack')
      await fireForsetiSevereAlerts(db, alertIds)
    } catch (err) {
      console.warn('[forseti-manual] slack alert dispatch failed:', err instanceof Error ? err.message : String(err))
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
