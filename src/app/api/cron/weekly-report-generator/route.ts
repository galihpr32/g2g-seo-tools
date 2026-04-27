import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'

export const maxDuration = 300

/**
 * GET /api/cron/weekly-report-generator
 *
 * Runs every Monday at 01:00 UTC (08:00 WIB) via GitHub Actions.
 * Generates the weekly report for the most recent completed Thu→Wed window
 * for every active owner (= owners with a connected GSC property).
 *
 * Iterates over owners and POSTs to /api/reports/weekly with cron auth header.
 * Failures are isolated per-owner — one bad owner doesn't block the rest.
 */
export async function GET(request: Request) {
  if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Active owners = anyone with a GSC connection
  const { data: owners, error: ownersErr } = await db
    .from('gsc_connections')
    .select('user_id')

  if (ownersErr) return NextResponse.json({ error: ownersErr.message }, { status: 500 })

  const uniqueOwners = Array.from(new Set((owners ?? []).map(o => o.user_id as string)))
  if (uniqueOwners.length === 0) {
    return NextResponse.json({ message: 'No active owners — nothing to generate.' })
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })
  }

  const results: Record<string, unknown> = {}

  for (const ownerId of uniqueOwners) {
    try {
      // Find the active site for this owner — try site_configs first, fall
      // back to 'g2g'. Each owner gets a single weekly report per site/week.
      const { data: sites } = await db
        .from('site_configs')
        .select('slug')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })

      const siteSlug = sites?.[0]?.slug as string | undefined ?? 'g2g'

      const res = await fetch(`${appUrl}/api/reports/weekly`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({
          owner_user_id: ownerId,
          site:          siteSlug,
          // No weekStart specified → POST handler defaults to last completed Thu→Wed
        }),
      })

      const payload = await res.json().catch(() => null)
      results[ownerId] = res.ok
        ? { ok: true, reportId: (payload as { report?: { id?: string } } | null)?.report?.id ?? null }
        : { ok: false, status: res.status, error: (payload as { error?: string } | null)?.error ?? 'unknown' }
    } catch (err) {
      results[ownerId] = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return NextResponse.json({
    triggered: uniqueOwners.length,
    results,
  })
}
