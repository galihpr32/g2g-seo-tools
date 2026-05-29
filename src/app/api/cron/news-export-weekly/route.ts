import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/news-export-weekly
 *
 * Iterates every (owner_user_id × site_slug) row in news_export_config with
 * weekly_cron_enabled = true and calls /api/news/export with cron auth so a
 * fresh set of date-stamped tabs lands in each brand's Sheet.
 *
 * Schedule: every Monday 01:00 UTC (08:00 WIB) — see
 * .github/workflows/news-export-weekly.yml.
 *
 * Auth: Bearer CRON_SECRET.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: configs, error } = await db
    .from('news_export_config')
    .select('owner_user_id, site_slug')
    .eq('weekly_cron_enabled', true)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!configs?.length) {
    return NextResponse.json({ ok: true, processed: 0, message: 'No brands configured for weekly export.' })
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  if (!appUrl) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })

  const results: Array<{ owner_user_id: string; site_slug: string; ok: boolean; tabs?: number; rows?: number; error?: string }> = []
  let succeeded = 0, failed = 0

  for (const c of configs) {
    try {
      const res = await fetch(`${appUrl}/api/news/export`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          owner_user_id: c.owner_user_id,
          site_slug:     c.site_slug,
          days:          14,   // 2-week window for weekly digest
        }),
      })
      const data = await res.json()
      if (!res.ok || data.error) {
        failed++
        results.push({
          owner_user_id: c.owner_user_id,
          site_slug:     c.site_slug,
          ok:            false,
          error:         data.error ?? `HTTP ${res.status}`,
        })
      } else {
        succeeded++
        results.push({
          owner_user_id: c.owner_user_id,
          site_slug:     c.site_slug,
          ok:            true,
          tabs:          data.tabs?.length ?? 0,
          rows:          data.rows_total ?? 0,
        })
      }
    } catch (e) {
      failed++
      results.push({
        owner_user_id: c.owner_user_id,
        site_slug:     c.site_slug,
        ok:            false,
        error:         e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok:        failed === 0,
    processed: configs.length,
    succeeded,
    failed,
    results,
  })
}
