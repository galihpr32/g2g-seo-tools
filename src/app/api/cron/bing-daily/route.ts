import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { getQueryStats, getPageStats, parseBingDate } from '@/lib/bing/client'

export const maxDuration = 60

/**
 * GET /api/cron/bing-daily
 *
 * Daily Bing Webmaster sync. Pulls query-level + page-level performance and
 * persists snapshots to bing_search_data.
 *
 * Auth: Bearer CRON_SECRET (called by GitHub Actions workflow).
 *
 * Bing API returns aggregated last-N-days data, not per-day. We snapshot
 * the aggregate at today's date and trust the user to look at deltas
 * across snapshot_date columns to derive day-over-day movement.
 *
 * Required env:
 *   - BING_WEBMASTER_API_KEY
 *   - BING_SITE_URL
 *   - G2G_OWNER_USER_ID  (the workspace owner whose data this represents)
 */
function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ownerId = process.env.G2G_OWNER_USER_ID
  const siteUrl = process.env.BING_SITE_URL

  if (!ownerId) return NextResponse.json({ error: 'G2G_OWNER_USER_ID not configured' }, { status: 500 })
  if (!siteUrl) return NextResponse.json({ error: 'BING_SITE_URL not configured' }, { status: 500 })

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date().toISOString().split('T')[0]
  const siteSlug = 'g2g'   // TODO: multi-site iteration once site_configs is wired

  try {
    // Fetch query + page stats in parallel
    const [queryStats, pageStats] = await Promise.all([
      getQueryStats(),
      getPageStats(),
    ])

    if (queryStats.length === 0 && pageStats.length === 0) {
      return NextResponse.json({
        ok: false,
        message: 'No data returned from Bing — check API key + site verification',
        synced_queries: 0,
        synced_pages:   0,
      })
    }

    // Build rows for bing_search_data (one per query, plus one per page)
    const rows: Array<Record<string, unknown>> = []

    for (const q of queryStats) {
      if (!q.Query) continue
      const ctr = q.Impressions > 0 ? Number(q.Clicks) / Number(q.Impressions) : 0
      rows.push({
        owner_user_id: ownerId,
        site_url:      siteUrl,
        site_slug:     siteSlug,
        snapshot_date: today,
        query:         q.Query,
        // Empty strings (not NULL) — table columns are NOT NULL with default '',
        // matches the unique index columns directly.
        page:          '',
        device:        '',
        country:       '',
        clicks:        q.Clicks ?? 0,
        impressions:   q.Impressions ?? 0,
        ctr,
        avg_position:  q.AvgImpressionPosition ?? null,
        raw:           q,
      })
    }

    // Page-level stats — stored under synthetic query='__page_aggregate__' so
    // they share the same table without conflicting with query-level rows.
    for (const p of pageStats) {
      if (!p.Page) continue
      const ctr = p.Impressions > 0 ? Number(p.Clicks) / Number(p.Impressions) : 0
      rows.push({
        owner_user_id: ownerId,
        site_url:      siteUrl,
        site_slug:     siteSlug,
        snapshot_date: today,
        query:         '__page_aggregate__',
        page:          p.Page,
        device:        '',
        country:       '',
        clicks:        p.Clicks ?? 0,
        impressions:   p.Impressions ?? 0,
        ctr,
        avg_position:  p.AvgImpressionPosition ?? null,
        raw:           p,
      })
    }

    // Bulk upsert (ON CONFLICT on the unique constraint = update existing snapshot)
    let inserted = 0
    if (rows.length > 0) {
      const { error } = await db
        .from('bing_search_data')
        .upsert(rows, {
          onConflict: 'owner_user_id,site_slug,snapshot_date,query,page,device,country',
          ignoreDuplicates: false,
        })

      if (error) {
        console.error('[bing-daily] upsert failed:', error)
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
      }
      inserted = rows.length
    }

    return NextResponse.json({
      ok:             true,
      snapshot_date:  today,
      site_slug:      siteSlug,
      synced_queries: queryStats.length,
      synced_pages:   pageStats.length,
      total_rows:     inserted,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[bing-daily] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
