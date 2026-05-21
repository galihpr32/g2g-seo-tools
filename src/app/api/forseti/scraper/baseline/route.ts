import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runForsetiScraper } from '@/lib/forseti/scraper'

export const maxDuration = 120

/**
 * POST /api/forseti/scraper/baseline
 *
 * Sprint FORSETI.BASELINE.1 — historical backfill of subreddit posts.
 * Unlike the regular /api/forseti/scraper/run which fetches only the latest
 * 100 posts (PullPush size=100 sort=desc), this paginates walking back by
 * `before` timestamp until reaching the cutoff date or the safety cap.
 *
 * Body:
 *   {
 *     lookback_days: 7 | 14 | 30 | 60 | 90 | 180   // required
 *     subreddit?:    string                          // optional scope to one sub
 *   }
 *
 * Safety caps inside the lib:
 *   • 20 paginated PullPush requests max  (= ~2000 posts cap)
 *   • Posts older than (now - lookback_days) are filtered out
 *
 * Returns the same shape as /api/forseti/scraper/run so the UI can reuse
 * its rendering logic.
 */
const VALID_LOOKBACKS = new Set([7, 14, 30, 60, 90, 180])

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    lookback_days?: number
    subreddit?:     string
  }
  const lookbackDays = Number(body.lookback_days)
  if (!VALID_LOOKBACKS.has(lookbackDays)) {
    return NextResponse.json({
      error: `lookback_days must be one of: ${Array.from(VALID_LOOKBACKS).join(', ')}`,
    }, { status: 400 })
  }
  const subreddit = body.subreddit?.trim() || undefined

  const results = await runForsetiScraper(db, { ownerId, subreddit, lookbackDays })

  // Sev-4+ alerts on inserts (same as normal run — for first-ever baseline,
  // there may be a flood of historical complaints worth knowing about).
  const alertIds = results.flatMap(r => r.alerts_needed)
  if (alertIds.length > 0) {
    try {
      const { fireForsetiSevereAlerts } = await import('@/lib/forseti/slack')
      await fireForsetiSevereAlerts(db, alertIds)
    } catch (err) {
      console.warn('[forseti-baseline] slack alert dispatch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return NextResponse.json({
    ok:           results.every(r => r.ok),
    ran_at:       new Date().toISOString(),
    lookback_days: lookbackDays,
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
