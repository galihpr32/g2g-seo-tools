import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { deliverFridayKpi } from '@/lib/reports/friday-kpi-deliver'

export const maxDuration = 120
export const runtime     = 'nodejs'

/**
 * GET /api/cron/friday-kpi
 *
 * Sprint FRIDAY.KPI — Combined G2G + OffGamers weekly digest.
 *
 * Auth: Bearer ${CRON_SECRET}. GitHub Actions calls this every Friday at
 * 08:00 UTC (= 15:00 WIB) via .github/workflows/friday-kpi.yml.
 *
 * For each (owner × first-active-site), we build ONE combined payload that
 * spans every brand that owner has configured under site_configs.is_active.
 * The digest is posted to a single channel resolved via slack_routing_config
 * notification_type='friday_kpi'.
 *
 * "One channel for both brands" is Galih's choice — the team reads them
 * together. If a future user wants per-brand split, add a query param
 * ?per_brand=1 and we'll loop instead.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Find every owner that has at least one GSC connection (proxy for "is
  // an active workspace") so we don't try to digest empty tenants.
  const { data: ownerRows } = await db
    .from('gsc_connections')
    .select('user_id')
  const owners = Array.from(new Set(
    (ownerRows ?? []).map(r => String(r.user_id)),
  )).filter(Boolean)

  if (owners.length === 0) {
    return NextResponse.json({ ok: true, message: 'No active owners.' })
  }

  // Active brands — applied uniformly to every owner. site_configs is a
  // global table in this deployment (no owner column).
  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  const siteSlugs = ((sites ?? []).map(s => String(s.slug))).filter(Boolean)
  if (siteSlugs.length === 0) siteSlugs.push('g2g')

  const results: Array<{
    ownerId:     string
    ok:          boolean
    posted:      boolean
    delivery?:   'png_upload' | 'webhook' | 'none'
    reason?:     string
    total_items?: number
  }> = []

  for (const ownerId of owners) {
    try {
      // Sprint FRIDAY.KPI.GRAPH.5 — deliverFridayKpi handles both PNG upload
      // and webhook fallback in one call. Returns payload + summary so we
      // can still report totals.
      const result = await deliverFridayKpi({ db, ownerId, siteSlugs })
      results.push({
        ownerId,
        ok:          result.ok,
        posted:      result.posted,
        delivery:    result.delivery,
        reason:      result.reason,
        total_items: result.summary.total_kws,
      })
    } catch (e) {
      results.push({ ownerId, ok: false, posted: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  return NextResponse.json({
    ok:        true,
    timestamp: new Date().toISOString(),
    sites:     siteSlugs,
    results,
  })
}
