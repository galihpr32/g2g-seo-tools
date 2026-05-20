import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runHuginAggregator } from '@/lib/hugin/aggregate'

export const maxDuration = 300

/**
 * GET /api/cron/hugin-aggregate
 *
 * Sprint HUGIN.CRON — Daily long-tail discovery aggregator.
 *
 * For each (owner × site × GSC property), reads gsc_query_snapshots across
 * 4 time windows (7d/30d/60d/90d) and upserts qualified long-tail queries
 * into hugin_queries with growth/new/position-climb signals computed.
 *
 * Suggested schedule: daily 04:30 UTC. Runs AFTER gsc-daily (which writes
 * the comprehensive snapshots) so we always work on fresh data.
 *
 * Auth: Bearer CRON_SECRET.
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

  // Load all GSC connections — one per (owner × site). Each connection holds
  // the GSC property URL we query against.
  const { data: connections, error } = await db
    .from('gsc_connections')
    .select('user_id, site_url, site_slug')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!connections || connections.length === 0) {
    return NextResponse.json({ ok: true, message: 'No GSC connections configured', results: [] })
  }

  // Group by (owner × site) — there can be multiple properties per workspace
  // but the aggregator is per workspace, so we iterate each connection.
  const results = []
  for (const conn of connections) {
    const ownerId  = conn.user_id  as string
    const siteUrl  = conn.site_url as string
    const siteSlug = (conn.site_slug as string | null) ?? 'g2g'

    const result = await runHuginAggregator(db, {
      ownerId,
      siteSlug,
      gscPropertyUrl: siteUrl,
    })
    results.push(result)
  }

  return NextResponse.json({
    ok:        results.every(r => !r.error),
    ran_at:    new Date().toISOString(),
    summary: {
      connections:   results.length,
      total_upserted: results.reduce((s, r) => s + r.total_upserted, 0),
    },
    per_owner: results,
  })
}
