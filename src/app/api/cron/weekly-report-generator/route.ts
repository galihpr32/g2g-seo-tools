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

  // Pull the full active-sites list ONCE — same list applies to every
  // owner (site_configs is shared across owners). The per-owner loop
  // below iterates (owner × site) pairs so OG and G2G both get their
  // own reports.
  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })

  const activeSlugs: string[] = (sites ?? []).map(s => s.slug as string)
  if (activeSlugs.length === 0) activeSlugs.push('g2g')   // fallback for empty config

  const results: Record<string, Record<string, unknown>> = {}
  let totalTriggered = 0

  for (const ownerId of uniqueOwners) {
    results[ownerId] = {}
    for (const siteSlug of activeSlugs) {
      totalTriggered++
      try {
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
        results[ownerId][siteSlug] = res.ok
          ? { ok: true, reportId: (payload as { report?: { id?: string } } | null)?.report?.id ?? null }
          : { ok: false, status: res.status, error: (payload as { error?: string } | null)?.error ?? 'unknown' }
      } catch (err) {
        results[ownerId][siteSlug] = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  return NextResponse.json({
    triggered: totalTriggered,
    owners:    uniqueOwners.length,
    sites:     activeSlugs,
    results,
  })
}
