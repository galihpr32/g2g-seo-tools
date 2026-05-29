import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { processPostsForConfig, type NormalizedPost, type SubredditConfig } from '@/lib/forseti/scraper'
import { fireForsetiSevereAlerts } from '@/lib/forseti/slack'

export const maxDuration = 60

/**
 * POST /api/forseti/ingest
 *
 * Sprint FORSETI.INGEST — backup path for when PullPush.io is unavailable
 * AND Reddit blocks our datacenter IP. A local poller script (see
 * scripts/forseti-local-poller.js) runs from a residential IP (Galih's Mac,
 * a personal VPS, etc.), fetches `reddit.com/r/X/new.json` directly, and
 * POSTs the result here. We run the same classify/score/upsert logic as
 * the cron scraper.
 *
 * Auth: bearer FORSETI_INGEST_TOKEN env var. Use a strong random string;
 * the poller embeds it. NEVER use SUPABASE_SERVICE_ROLE_KEY — this token is
 * scoped to ingest-only.
 *
 * Body:
 *   {
 *     subreddit: "G2G_com",
 *     posts: NormalizedPost[]
 *   }
 *
 *   NormalizedPost = {
 *     id:           "1abcdef",          // Reddit submission ID, no t3_ prefix
 *     title:        string,
 *     selftext:     string,
 *     author:       string | null,
 *     score:        number,
 *     num_comments: number,
 *     created_utc:  number,             // Unix seconds
 *     permalink:    "/r/.../comments/..." // relative
 *     subreddit:    string,
 *     removed_by_category?: string | null
 *   }
 *
 * The poller is responsible for mapping Reddit's response shape to this
 * NormalizedPost format. Example mapping shown in the poller script.
 */

function isIngestAuth(request: Request): boolean {
  const auth = request.headers.get('authorization')
  const token = process.env.FORSETI_INGEST_TOKEN
  if (!token) return false      // misconfig — better to refuse than auth-bypass
  return auth === `Bearer ${token}`
}

export async function POST(req: Request) {
  if (!isIngestAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({})) as {
    subreddit?: string
    posts?:     NormalizedPost[]
  }

  const subreddit = String(body.subreddit ?? '').trim()
  if (!subreddit) {
    return NextResponse.json({ error: 'subreddit required' }, { status: 400 })
  }

  const posts = Array.isArray(body.posts) ? body.posts : []
  if (posts.length === 0) {
    return NextResponse.json({ ok: true, message: 'no posts in payload', processed: 0 })
  }

  const db = createServiceClient()

  // Find the config(s) for this subreddit — there can be multiple (one per
  // owner × site). All enabled configs that monitor this sub get the ingest.
  const { data: configs, error: cfgErr } = await db
    .from('forseti_subreddit_configs')
    .select('*')
    .eq('subreddit', subreddit)
    .eq('enabled',   true)

  if (cfgErr) {
    return NextResponse.json({ error: `config load failed: ${cfgErr.message}` }, { status: 500 })
  }
  if (!configs || configs.length === 0) {
    return NextResponse.json({
      ok:    false,
      error: `No enabled config found for r/${subreddit}. Configure it at /forseti/settings first.`,
    }, { status: 404 })
  }

  const ranAt = new Date().toISOString()
  const results = []
  const allAlertIds: string[] = []

  for (const config of configs as SubredditConfig[]) {
    const processed = await processPostsForConfig(db, config, posts)
    allAlertIds.push(...processed.alerts_needed)

    // Mark config polled successfully (mirror cron behavior)
    await db.from('forseti_subreddit_configs').update({
      status:               'ok',
      last_error:           null,
      last_polled_at:       ranAt,
      last_polled_threads:  processed.matched,
      total_threads:        ((config as unknown as { total_threads?: number }).total_threads ?? 0) + processed.inserted,
      updated_at:           ranAt,
    }).eq('id', config.id)

    results.push({
      config_id:     config.id,
      owner_user_id: config.owner_user_id,
      site_slug:     config.site_slug,
      ...processed,
    })
  }

  // Fire sev-4+ alerts if any new threads landed in the alert tier
  if (allAlertIds.length > 0) {
    try {
      await fireForsetiSevereAlerts(db, allAlertIds)
    } catch (err) {
      console.warn('[forseti-ingest] slack alert dispatch failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return NextResponse.json({
    ok:            true,
    ran_at:        ranAt,
    subreddit,
    posts_seen:    posts.length,
    summary: {
      configs:      results.length,
      matched:      results.reduce((s, r) => s + r.matched,  0),
      inserted:     results.reduce((s, r) => s + r.inserted, 0),
      updated:      results.reduce((s, r) => s + r.updated,  0),
      filtered:     results.reduce((s, r) => s + r.filtered, 0),
      alerts_fired: allAlertIds.length,
    },
    per_config: results,
  })
}
