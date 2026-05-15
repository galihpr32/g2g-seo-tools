import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { buildFridayKpi, buildFridayKpiSlackBlocks } from '@/lib/reports/friday-kpi'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 120

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

  const results: Array<{ ownerId: string; ok: boolean; posted: boolean; reason?: string; total_items?: number }> = []

  for (const ownerId of owners) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const payload = await buildFridayKpi(db, ownerId, siteSlugs)
      const { text, blocks } = buildFridayKpiSlackBlocks(payload)

      // eslint-disable-next-line no-await-in-loop
      const webhookUrl = await resolveSlackWebhook(db, ownerId, 'friday_kpi')
      if (!webhookUrl) {
        results.push({ ownerId, ok: true, posted: false, reason: 'no_webhook_configured', total_items: payload.brands.reduce((s, b) => s + b.total_items, 0) })
        continue
      }

      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, blocks }),
      })

      results.push({
        ownerId,
        ok:          res.ok,
        posted:      res.ok,
        reason:      res.ok ? undefined : `slack_${res.status}`,
        total_items: payload.brands.reduce((s, b) => s + b.total_items, 0),
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
