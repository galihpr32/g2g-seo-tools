import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/cannib-snapshot
 *
 * Weekly cron — for each (owner, site) pair that has a GSC connection,
 * calls /api/cannibalization with auth bypass and persists the resulting
 * groups into cannibalization_snapshots. The detail page reads back from
 * this table to render the trend timeline.
 *
 * Strategy: rather than re-implement detection here, we proxy through the
 * existing endpoint via internal fetch. APP_URL is required.
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

interface CannibGroup {
  query:        string
  pages:        Array<{ page: string; clicks: number; impressions: number; position: number }>
  total_clicks: number
  total_impressions: number
  split_score:  number
  severity:     'critical' | 'warning' | 'info'
  recommendation: string
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().slice(0, 10)
  const stats = { sites: 0, owners: 0, snapshots_written: 0, errors: [] as string[] }

  // Iterate active sites + each owner with a GSC connection.
  const { data: sites } = await db.from('site_configs').select('slug, gsc_property').eq('is_active', true)
  if (!sites?.length) return NextResponse.json({ error: 'No active sites' }, { status: 500 })

  const appUrl = (process.env.APP_URL ?? '').replace(/\/+$/, '')
  if (!appUrl) return NextResponse.json({ error: 'APP_URL not configured' }, { status: 500 })

  for (const site of sites) {
    stats.sites++
    const siteSlug = String(site.slug)

    // Find owners for this site that have GSC connection
    const { data: conns } = await db
      .from('gsc_connections')
      .select('user_id, site_url')
      .eq('site_url', site.gsc_property)

    for (const conn of (conns ?? []) as Array<{ user_id: string; site_url: string }>) {
      stats.owners++
      const ownerId = String(conn.user_id)

      try {
        // Cron-internal fetch — uses CRON_SECRET as the body trust signal so
        // /api/cannibalization can resolve owner without an auth cookie.
        // (Alternative: re-implement detection here. Proxy keeps logic DRY.)
        const res = await fetch(`${appUrl}/api/cannibalization?days=30&min_impr=10&owner=${encodeURIComponent(ownerId)}&cron_secret=${encodeURIComponent(process.env.CRON_SECRET!)}`, {
          headers: { 'Content-Type': 'application/json' },
        })
        if (!res.ok) {
          stats.errors.push(`[${siteSlug}/${ownerId}] cannib fetch ${res.status}`)
          continue
        }
        const data = await res.json() as { groups?: CannibGroup[] }
        const groups = data.groups ?? []

        if (groups.length === 0) continue

        const rows = groups.map(g => ({
          owner_user_id:    ownerId,
          site_slug:        siteSlug,
          query:            g.query,
          snapshot_date:    today,
          severity:         g.severity,
          page_count:       g.pages.length,
          total_clicks:     g.total_clicks,
          total_impressions: g.total_impressions,
          split_score:      g.split_score,
          pages:            g.pages,
          recommendation:   g.recommendation,
        }))

        // Chunked upsert
        const CHUNK = 200
        for (let i = 0; i < rows.length; i += CHUNK) {
          const { error } = await db
            .from('cannibalization_snapshots')
            .upsert(rows.slice(i, i + CHUNK), {
              onConflict: 'owner_user_id,site_slug,query,snapshot_date',
              ignoreDuplicates: false,
            })
          if (error) stats.errors.push(`[${siteSlug}/${ownerId}] chunk ${i}: ${error.message}`)
          else stats.snapshots_written += Math.min(CHUNK, rows.length - i)
        }
      } catch (err) {
        stats.errors.push(`[${siteSlug}/${ownerId}] ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return NextResponse.json({ ok: stats.errors.length === 0, when: new Date().toISOString(), stats })
}
