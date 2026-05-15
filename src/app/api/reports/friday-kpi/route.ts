import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { buildFridayKpi, buildFridayKpiSlackBlocks } from '@/lib/reports/friday-kpi'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 60

/**
 * Sprint FRIDAY.KPI — Session-authenticated manual trigger + preview.
 *
 * GET  /api/reports/friday-kpi          → returns the digest payload as JSON
 *                                          (preview before sending)
 * POST /api/reports/friday-kpi/send     → builds payload + posts to Slack
 *
 * This route is for the UI button. The cron variant at
 * /api/cron/friday-kpi uses CRON_SECRET; that one stays for the GitHub
 * Actions schedule. The UI route uses normal Supabase auth — Galih
 * doesn't need to remember the cron secret to fire a test run.
 */

async function buildPayloadForCurrentUser(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized', status: 401 as const }

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const db       = createServiceClient()

  // Use the same site discovery as the cron — covers G2G + OG together.
  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  const siteSlugs = ((sites ?? []).map(s => String(s.slug))).filter(Boolean)
  if (siteSlugs.length === 0) siteSlugs.push('g2g')

  // Allow ?sites=g2g,offgamers override for ad-hoc test
  const url = new URL(req.url)
  const override = url.searchParams.get('sites')
  const finalSlugs = override
    ? override.split(',').map(s => s.trim()).filter(Boolean)
    : siteSlugs

  const payload = await buildFridayKpi(db, ownerId, finalSlugs)
  return { ok: true as const, ownerId, db, payload, finalSlugs }
}

export async function GET(req: Request) {
  try {
    const res = await buildPayloadForCurrentUser(req)
    if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status })

    return NextResponse.json({
      ok:           true,
      sites:        res.finalSlugs,
      payload:      res.payload,
      slack_blocks: buildFridayKpiSlackBlocks(res.payload),
    })
  } catch (err) {
    console.error('[friday-kpi GET] build failed:', err)
    return NextResponse.json({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 800) : undefined,
    }, { status: 500 })
  }
}

export async function POST(req: Request) {
  let res
  try {
    res = await buildPayloadForCurrentUser(req)
  } catch (err) {
    console.error('[friday-kpi POST] build failed:', err)
    return NextResponse.json({
      ok:     false,
      posted: false,
      reason: `build_failed: ${err instanceof Error ? err.message : String(err)}`,
    }, { status: 500 })
  }
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: res.status })

  const { ownerId, db, payload, finalSlugs } = res
  const { text, blocks } = buildFridayKpiSlackBlocks(payload)

  const webhookUrl = await resolveSlackWebhook(db, ownerId, 'friday_kpi')
  if (!webhookUrl) {
    return NextResponse.json({
      ok:     false,
      posted: false,
      reason: 'no_webhook_configured',
      hint:   'Set a Slack webhook for notification_type=friday_kpi in /settings/slack-routing.',
      sites:  finalSlugs,
    }, { status: 412 })
  }

  const slackRes = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text, blocks }),
  }).catch(e => ({ ok: false, status: 0, _err: String(e) } as Response & { _err?: string }))

  return NextResponse.json({
    ok:           slackRes.ok,
    posted:       slackRes.ok,
    slack_status: slackRes.status,
    sites:        finalSlugs,
    summary: {
      total_items:    payload.brands.reduce((s, b) => s + b.total_items, 0),
      anthropic_usd:  payload.cost.anthropicUsd,
      enrolled_briefs: payload.experiments.id_native_ab.enrolled_total,
    },
  })
}
