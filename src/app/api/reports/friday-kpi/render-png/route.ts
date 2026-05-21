import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildFridayKpi } from '@/lib/reports/friday-kpi'
import { buildActionPlan } from '@/lib/reports/action-plan-synthesizer'
import { renderFridayKpiHtml } from '@/lib/reports/friday-kpi-html'
import { htmlToPng } from '@/lib/reports/puppeteer-launcher'

/**
 * Sprint FRIDAY.KPI.GRAPH.4 — renders the Friday KPI dashboard as a PNG.
 *
 * GET /api/reports/friday-kpi/render-png?download=1
 *   ?download=1 triggers a Content-Disposition attachment header
 *
 * Used by:
 *   • Preview button on /reports/friday-kpi (?download=1)
 *   • Slack cron (no flag, raw PNG to upload via files.upload)
 */
export const runtime     = 'nodejs'
export const maxDuration = 60
export const dynamic     = 'force-dynamic'

function isoWeek(): string {
  const d = new Date()
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr  = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNum  = 1 + Math.round(((target.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  // Same site discovery as the cron/preview routes: active rows in site_configs
  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  const siteSlugs = ((sites ?? []).map(s => String(s.slug))).filter(Boolean)
  if (siteSlugs.length === 0) siteSlugs.push('g2g')

  const url      = new URL(req.url)
  const download = url.searchParams.get('download') === '1'
  const week     = isoWeek()

  try {
    // 1. Build payload (same data as the live preview)
    const payload = await buildFridayKpi(db, ownerId, siteSlugs)

    // 2. Build per-brand action plans in parallel
    const actionPlans = await Promise.all(
      siteSlugs.map(async slug => ({
        brand: slug,
        plan:  await buildActionPlan({ db, ownerId, siteSlug: slug, weekIso: week }),
      })),
    )

    // 3. Render HTML → PNG
    const html = renderFridayKpiHtml({ payload, actionPlans })
    const png  = await htmlToPng(html)

    const headers: Record<string, string> = {
      'Content-Type':   'image/png',
      'Cache-Control':  'no-store',
    }
    if (download) {
      headers['Content-Disposition'] = `attachment; filename="friday-kpi-${week}.png"`
    }
    return new Response(new Uint8Array(png), { status: 200, headers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[friday-kpi render-png] failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
