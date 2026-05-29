import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildFridayKpi } from '@/lib/reports/friday-kpi'
import { buildActionPlan } from '@/lib/reports/action-plan-synthesizer'
import { renderFridayKpiHtml } from '@/lib/reports/friday-kpi-html'
import { htmlToPng } from '@/lib/reports/puppeteer-launcher'
// Sprint FRIDAY.KPI.PREVIEW-AI-FIX — Preview PNG was missing the AI
// Visibility historical chart because this route never fetched aiHistory.
// Slack delivery path always did. Now we share the same loader.
// Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — same story for the 12-week
// hero chart: preview must include it so it matches the Slack delivery PNG.
import { loadAiVisibilityHistory, loadGscHistorical, loadCompetitiveTrend } from '@/lib/reports/friday-kpi-deliver'

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
// Sprint FRIDAY.KPI.GRAPH.4 hotfix — bumped from 60s to 300s.
// Cold start budget: ~30s chromium tarball download + extraction, ~15-20s
// buildFridayKpi (SERP + Supabase joins), ~10-15s × N brands action plan
// (Haiku calls), ~10s puppeteer launch+screenshot. 60s ceiling hit reliably
// on cold starts. Warm subsequent calls finish in ~12-18s.
// Requires Vercel Pro (max 300s); fall back to 60 if on Hobby tier.
export const maxDuration = 300
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

  const t0 = Date.now()
  const tlog = (label: string) => console.log(`[friday-kpi render-png] ${label} +${Date.now() - t0}ms`)
  try {
    // Sprint FRIDAY.KPI.GRAPH.4 hotfix — run payload + per-brand action plans
    // IN PARALLEL (previously sequential, costing 15-30s on cold start).
    //
    // Sprint FRIDAY.KPI.PREVIEW-AI-FIX — also fetch the 84-day AI Visibility
    // history alongside, so the Preview PNG matches what the Slack delivery
    // path renders. Returns empty buckets gracefully if no snapshots exist.
    //
    // Sprint FRIDAY.KPI.HERO-HISTORICAL (336) — also fetch the 12-week
    // GSC clicks/impressions hero data. Falls back to empty (chart hidden)
    // if GSC OAuth missing.
    tlog('start')
    const [payload, aiHistory, gscHistorical, competitiveTrend, ...actionPlans] = await Promise.all([
      buildFridayKpi(db, ownerId, siteSlugs),
      loadAiVisibilityHistory(db, ownerId, siteSlugs, 84),
      loadGscHistorical(db, ownerId, siteSlugs, 12),
      loadCompetitiveTrend(db, ownerId, siteSlugs, 12),
      ...siteSlugs.map(async slug => ({
        brand: slug,
        plan:  await buildActionPlan({ db, ownerId, siteSlug: slug, weekIso: week }),
      })),
    ])
    tlog('data assembled')

    // Render HTML → PNG (chromium cold start usually dominates here)
    const html = renderFridayKpiHtml({ payload, actionPlans, aiHistory, gscHistorical, competitiveTrend })
    tlog('html built')
    const png  = await htmlToPng(html)
    tlog('png ready')

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
