import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { getRefreshedClientFull } from '@/lib/gsc/auth'
import { getSearchAnalytics, getDateRange } from '@/lib/gsc/client'

export const maxDuration = 60

/**
 * POST /api/priority-products/refresh-gsc
 *
 * Sprint PP.GSC.REFRESH — manual GSC fetch for the rankings dashboard.
 * Lighter than the full gsc-daily cron — just pulls (page × query) snapshot
 * for the last 7d window and upserts to gsc_query_snapshots so the rankings
 * dashboard sees fresh data without waiting for the nightly cron.
 *
 * Body: { window_days?: number }   // default 7, max 28
 *
 * Returns:
 *   { ok, fetched, written, skipped_duplicates, window_start, window_end,
 *     snapshot_date, gsc_property_url }
 *
 * Auth: caller's session (no CRON_SECRET required). Scoped to caller's owner.
 */
const GSC_LAG_DAYS = 4

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const body = await req.json().catch(() => ({})) as { window_days?: number }
  const windowDays = Math.min(28, Math.max(1, Number(body.window_days) || 7))

  // 1. Resolve GSC property URL for this site
  const { data: siteCfg } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .maybeSingle()
  const gscPropertyUrl = siteCfg?.gsc_property as string | undefined
  if (!gscPropertyUrl) {
    return NextResponse.json({
      error: `No GSC property configured for site '${siteSlug}'. Set it at /settings.`,
    }, { status: 400 })
  }

  // 2. Resolve OAuth tokens (one set per owner, covers all GSC properties)
  const { data: conn } = await db
    .from('gsc_connections')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()
  if (!conn) {
    return NextResponse.json({
      error: `No GSC OAuth connection. Connect at /settings/google.`,
    }, { status: 400 })
  }

  // 3. Refresh token if needed + persist new credentials
  let auth
  try {
    const refreshed = await getRefreshedClientFull(
      conn.access_token, conn.refresh_token, conn.expires_at,
    )
    auth = refreshed.client
    if (refreshed.newCredentials) {
      await db.from('gsc_connections').update({
        access_token: refreshed.newCredentials.accessToken,
        expires_at:   refreshed.newCredentials.expiresAt,
      }).eq('user_id', ownerId)
    }
  } catch (err) {
    return NextResponse.json({
      error: `GSC OAuth refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 })
  }

  // 4. Date range: [today - lag - (window-1), today - lag]
  // Equivalent to "last N days of complete GSC data" — lag accounts for the
  // ~3-4 day GSC reporting delay. getDateRange(N) returns "today - N days".
  const startDate = getDateRange(GSC_LAG_DAYS + windowDays - 1)
  const endDate   = getDateRange(GSC_LAG_DAYS)
  const todayIso  = new Date().toISOString().slice(0, 10)

  // 5. Fetch (page × query) with rowLimit 25000 (max single-call)
  let rows: Awaited<ReturnType<typeof getSearchAnalytics>>
  try {
    rows = await getSearchAnalytics(
      auth,
      gscPropertyUrl,
      startDate,
      endDate,
      ['page', 'query'],
      25000,
    )
  } catch (err) {
    return NextResponse.json({
      error: `GSC searchanalytics call failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 502 })
  }

  // 6. Build insert payload — snapshot_date = today (matches gsc-daily pattern)
  // so the rankings dashboard's snapshot-based query picks this up as "latest".
  const inserts = (rows ?? [])
    .filter(r => (r.keys?.[1] ?? '').trim().length > 0 && (r.keys?.[0] ?? '').trim().length > 0)
    .map(r => ({
      site_url:      gscPropertyUrl,
      snapshot_date: todayIso,
      page:          r.keys?.[0] ?? '',
      query:         (r.keys?.[1] ?? '').toLowerCase().trim().slice(0, 500),
      clicks:        r.clicks      ?? 0,
      impressions:   r.impressions ?? 0,
      ctr:           r.ctr         ?? 0,
      position:      r.position    ?? 0,
    }))

  // 7. Chunked upsert (500 per batch)
  let written = 0
  const warnings: string[] = []
  for (let i = 0; i < inserts.length; i += 500) {
     
    const { error: upErr } = await db
      .from('gsc_query_snapshots')
      .upsert(inserts.slice(i, i + 500), {
        onConflict:       'site_url,snapshot_date,page,query',
        ignoreDuplicates: false,    // overwrite so a re-run reflects fresh metrics
      })
    if (upErr) {
      warnings.push(`upsert batch ${i / 500 + 1}: ${upErr.message}`)
    } else {
      written += inserts.slice(i, i + 500).length
    }
  }

  return NextResponse.json({
    ok:                 warnings.length === 0,
    fetched:            (rows ?? []).length,
    written,
    window_start:       startDate,
    window_end:         endDate,
    snapshot_date:      todayIso,
    window_days:        windowDays,
    gsc_property_url:   gscPropertyUrl,
    warnings,
  })
}
