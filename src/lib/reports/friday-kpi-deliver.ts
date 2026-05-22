// ── Friday KPI delivery (Slack PNG with webhook fallback) ─────────────────
//
// Sprint FRIDAY.KPI.GRAPH.5 — shared by /api/reports/friday-kpi (manual
// send) and /api/cron/friday-kpi (Friday 15:00 WIB cron). Tries to upload
// the rendered PNG via Slack files.uploadV2; falls back to the existing
// text+blocks webhook delivery if the bot token or channel ID is missing.
//
// One owner. The caller is responsible for figuring out which owner →
// looping happens upstream in the cron route.

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFridayKpi, buildFridayKpiSlackBlocks, buildPngOverviewComment, type FridayKpiPayload } from './friday-kpi'
import { buildActionPlan } from './action-plan-synthesizer'
import { renderFridayKpiHtml } from './friday-kpi-html'
import { htmlToPng } from './puppeteer-launcher'
import { resolveSlackWebhook } from '@/lib/slack/routing'
import { resolveSlackChannelId, postPngToSlack } from '@/lib/slack/files'

function currentWeekIso(): string {
  const d = new Date()
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNr  = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThu = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const weekNum  = 1 + Math.round(((target.getTime() - firstThu.getTime()) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

export interface DeliveryResult {
  ok:           boolean
  posted:       boolean
  delivery:     'png_upload' | 'webhook' | 'none'
  slack_status?: number
  reason?:      string
  hint?:        string
  payload:      FridayKpiPayload
  summary: {
    total_kws: number
    brands:    number
    iso_week:  number
  }
}

export interface DeliveryOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>
  ownerId:   string
  siteSlugs: string[]
}

export async function deliverFridayKpi(opts: DeliveryOptions): Promise<DeliveryResult> {
  const { db, ownerId, siteSlugs } = opts

  // 1. Build the payload (existing logic — unchanged)
  const payload = await buildFridayKpi(db, ownerId, siteSlugs)
  const { text, blocks } = buildFridayKpiSlackBlocks(payload)
  const totalKws = payload.brands.reduce(
    (s, b) => s + b.serp.reduce((ss, m) => ss + m.kw_count, 0), 0,
  )
  const summary = { total_kws: totalKws, brands: payload.brands.length, iso_week: payload.iso_week }

  // 2. Resolve delivery target (PNG upload preferred when configured)
  const [channelId, webhookUrl] = await Promise.all([
    resolveSlackChannelId(db, ownerId, 'friday_kpi'),
    resolveSlackWebhook(db, ownerId, 'friday_kpi'),
  ])

  if (!channelId && !webhookUrl) {
    return {
      ok:       false,
      posted:   false,
      delivery: 'none',
      reason:   'no_webhook_configured',
      hint:     'Set a webhook URL (or channel ID + bot token) for notification_type=friday_kpi in /settings/slack-routing.',
      payload,
      summary,
    }
  }

  // 3. Try PNG upload first
  if (channelId && process.env.SLACK_BOT_TOKEN) {
    try {
      const week = currentWeekIso()
      const actionPlans = await Promise.all(
        siteSlugs.map(async slug => ({
          brand: slug,
          plan:  await buildActionPlan({ db, ownerId, siteSlug: slug, weekIso: week }),
        })),
      )
      const html = renderFridayKpiHtml({ payload, actionPlans })
      const png  = await htmlToPng(html)
      // Sprint FRIDAY.KPI.SLACK-SIMPLIFY — PNG already shows full tables;
      // the Slack initial_comment is now a short brief, not duplicated blocks.
      const overview = buildPngOverviewComment(payload)
      const up   = await postPngToSlack({
        buffer:         png,
        filename:       `weekly-report-${week}.png`,
        channelId,
        initialComment: overview,
        title:          `Weekly Report · ${payload.week_label}`,
      })
      if (up.ok) {
        return {
          ok:          true,
          posted:      true,
          delivery:    'png_upload',
          slack_status: up.status,
          payload,
          summary,
        }
      }
      // PNG upload failed — log + fall through to webhook
      console.warn('[friday-kpi deliver] PNG upload failed, falling back to webhook:', up.error)
    } catch (e) {
      console.warn('[friday-kpi deliver] PNG render/upload threw, falling back to webhook:', e instanceof Error ? e.message : String(e))
    }
  }

  // 4. Webhook fallback — Sprint FRIDAY.KPI.SLACK-SIMPLIFY hardening.
  // Even without bot-token setup, we send a SLIM overview text + link to
  // the dashboard, NOT the bloated tabular blocks. The full data lives in
  // /reports/friday-kpi (where user can click Preview PNG manually).
  // Variables `text` and `blocks` are kept above for compat but no longer
  // sent — webhook path uses short overview just like PNG mode.
  if (webhookUrl) {
    // Webhook mode: no PNG attachment possible, so overview tells user
    // to open the dashboard for the visual.
    const overview = buildPngOverviewComment(payload, { withPng: false })
    const appUrl   = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
    const dashLink = appUrl ? `${appUrl}/reports/friday-kpi` : ''
    const slimText = dashLink
      ? `${overview}\n👉 View live dashboard + download PNG: ${dashLink}`
      : overview

    try {
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text: slimText }),
      })
      // Silence unused-var lint for `text` and `blocks` from earlier build.
      void text; void blocks
      return {
        ok:           res.ok,
        posted:       res.ok,
        delivery:     'webhook',
        slack_status: res.status,
        reason:       res.ok ? undefined : `slack_${res.status}`,
        payload,
        summary,
      }
    } catch (e) {
      return {
        ok:       false,
        posted:   false,
        delivery: 'webhook',
        reason:   `webhook_throw: ${e instanceof Error ? e.message : String(e)}`,
        payload,
        summary,
      }
    }
  }

  return {
    ok:       false,
    posted:   false,
    delivery: 'none',
    reason:   'png_upload_failed_and_no_webhook_fallback',
    payload,
    summary,
  }
}
