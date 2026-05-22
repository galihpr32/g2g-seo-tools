// ── Friday KPI delivery (Slack PNG with webhook fallback) ─────────────────
//
// Sprint FRIDAY.KPI.GRAPH.5 — PNG upload (files.uploadV2) with webhook
// fallback. Both modes now include Public Report + Methodology action
// buttons (Sprint FRIDAY.KPI.SLACK-BUTTONS).

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFridayKpi, buildPngOverviewComment, type FridayKpiPayload } from './friday-kpi'
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
  /** Sprint FRIDAY.KPI.SLACK-BUTTONS — diagnostic info so caller can see
   *  why PNG mode wasn't reached (token missing, channel not set, upload
   *  failed, etc). Shows up in API response for user-side debugging. */
  png_diagnostic?: {
    channel_id_configured:  boolean
    bot_token_present:      boolean
    upload_attempted:       boolean
    upload_error?:          string
  }
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

// ─── Slack message builders ────────────────────────────────────────────────

/**
 * Build the action buttons block. Both Public Report + Methodology buttons,
 * gated on URLs existing in payload. Returned as a single 'actions' block
 * for Slack Block Kit.
 */
function buildActionButtons(payload: FridayKpiPayload): Record<string, unknown> | null {
  const elements: Array<Record<string, unknown>> = []
  if (payload.public_url) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '📄 Public Report', emoji: true },
      url:  payload.public_url,
      style: 'primary',
    })
  }
  if (payload.methodology_url) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: '🎯 Methodology', emoji: true },
      url:  payload.methodology_url,
    })
  }
  if (elements.length === 0) return null
  return { type: 'actions', elements }
}

/**
 * Build the inline link string for PNG mode initial_comment. Since
 * files.uploadV2 only supports plain text initial_comment, we use Slack
 * markdown link syntax `<url|label>` which renders as clickable links.
 */
function buildInlineLinks(payload: FridayKpiPayload): string {
  const parts: string[] = []
  if (payload.public_url)      parts.push(`📄 <${payload.public_url}|Public Report>`)
  if (payload.methodology_url) parts.push(`🎯 <${payload.methodology_url}|Methodology>`)
  return parts.join('  ·  ')
}

// ─── Main entry ────────────────────────────────────────────────────────────

export async function deliverFridayKpi(opts: DeliveryOptions): Promise<DeliveryResult> {
  const { db, ownerId, siteSlugs } = opts

  // 1. Build the payload
  const payload = await buildFridayKpi(db, ownerId, siteSlugs)
  const totalKws = payload.brands.reduce(
    (s, b) => s + b.serp.reduce((ss, m) => ss + m.kw_count, 0), 0,
  )
  const summary = { total_kws: totalKws, brands: payload.brands.length, iso_week: payload.iso_week }

  // 2. Resolve delivery target (PNG upload preferred when configured)
  const [channelId, webhookUrl] = await Promise.all([
    resolveSlackChannelId(db, ownerId, 'friday_kpi'),
    resolveSlackWebhook(db, ownerId, 'friday_kpi'),
  ])
  const botTokenPresent = !!process.env.SLACK_BOT_TOKEN

  // Build diagnostic snapshot for response (so user can see config state)
  const pngDiag = {
    channel_id_configured: !!channelId,
    bot_token_present:     botTokenPresent,
    upload_attempted:      false,
    upload_error:          undefined as string | undefined,
  }

  if (!channelId && !webhookUrl) {
    return {
      ok:       false,
      posted:   false,
      delivery: 'none',
      reason:   'no_webhook_configured',
      hint:     'Set a webhook URL (or channel ID + bot token) for notification_type=friday_kpi in /settings/slack-routing.',
      png_diagnostic: pngDiag,
      payload,
      summary,
    }
  }

  // 3. Try PNG upload first — Sprint FRIDAY.KPI.PNG-SPLIT delivers THREE
  // sequential PNGs to the same channel so each section reads cleanly:
  //   (1) Metrics: chart + competitive + traffic   ← initial_comment + buttons
  //   (2) AI Visibility                            ← no initial_comment
  //   (3) Action Plan                              ← short caption
  // If any upload fails, mark the whole flow failed and fall back to webhook.
  if (channelId && botTokenPresent) {
    pngDiag.upload_attempted = true
    try {
      const week = currentWeekIso()
      const actionPlans = await Promise.all(
        siteSlugs.map(async slug => ({
          brand: slug,
          plan:  await buildActionPlan({ db, ownerId, siteSlug: slug, weekIso: week }),
        })),
      )

      // Render three HTML variants in parallel, then puppeteer them in
      // sequence (puppeteer-launcher reuses the browser, so concurrent
      // htmlToPng() calls would step on each other).
      const htmlMain    = renderFridayKpiHtml({ payload, actionPlans, mode: 'main' })
      const htmlAi      = renderFridayKpiHtml({ payload, actionPlans, mode: 'ai' })
      const htmlActions = renderFridayKpiHtml({ payload, actionPlans, mode: 'actions' })
      const pngMain    = await htmlToPng(htmlMain)
      const pngAi      = await htmlToPng(htmlAi)
      const pngActions = await htmlToPng(htmlActions)

      // Build per-image captions. Only the first carries the brand overview
      // + action-link buttons; the next two are short identifiers.
      const overview     = buildPngOverviewComment(payload)
      const links        = buildInlineLinks(payload)
      const mainComment  = links ? `${overview}\n${links}` : overview
      const aiComment    = `🤖 AI Visibility · Week ${payload.iso_week}`
      const actComment   = `🎯 Action Plan · Week ${payload.iso_week}`

      const uploads = [
        { buffer: pngMain,    filename: `weekly-report-${week}-1-metrics.png`,      initialComment: mainComment, title: `Weekly Report · ${payload.week_label} · Metrics` },
        { buffer: pngAi,      filename: `weekly-report-${week}-2-ai-visibility.png`, initialComment: aiComment,   title: `Weekly Report · ${payload.week_label} · AI Visibility` },
        { buffer: pngActions, filename: `weekly-report-${week}-3-action-plan.png`,  initialComment: actComment,  title: `Weekly Report · ${payload.week_label} · Action Plan` },
      ]

      let lastStatus: number | undefined
      for (const u of uploads) {
        const up = await postPngToSlack({ channelId, ...u })
        lastStatus = up.status
        if (!up.ok) {
          pngDiag.upload_error = up.error ?? `slack_${up.status}`
          throw new Error(`PNG upload failed at "${u.filename}": ${pngDiag.upload_error}`)
        }
      }

      return {
        ok:          true,
        posted:      true,
        delivery:    'png_upload',
        slack_status: lastStatus,
        png_diagnostic: pngDiag,
        payload,
        summary,
      }
    } catch (e) {
      if (!pngDiag.upload_error) pngDiag.upload_error = e instanceof Error ? e.message : String(e)
      console.warn('[friday-kpi deliver] PNG split upload failed, falling back to webhook:', pngDiag.upload_error)
    }
  }

  // 4. Webhook fallback — sends Block Kit message with overview section
  // + action buttons (Public Report + Methodology). No PNG, but clean.
  if (webhookUrl) {
    const overview = buildPngOverviewComment(payload, { withPng: false })
    const appUrl   = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
    const dashLink = appUrl ? `${appUrl}/reports/friday-kpi` : ''

    const blocks: Array<Record<string, unknown>> = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: overview },
      },
    ]
    const actionBlock = buildActionButtons(payload)
    if (actionBlock) blocks.push(actionBlock)
    if (dashLink) {
      blocks.push({
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `🔗 <${dashLink}|Open live dashboard> to download the PNG snapshot` },
        ],
      })
    }

    try {
      const res = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          text:   overview,    // fallback for clients that don't render blocks
          blocks,
        }),
      })
      return {
        ok:           res.ok,
        posted:       res.ok,
        delivery:     'webhook',
        slack_status: res.status,
        reason:       res.ok ? undefined : `slack_${res.status}`,
        png_diagnostic: pngDiag,
        payload,
        summary,
      }
    } catch (e) {
      return {
        ok:       false,
        posted:   false,
        delivery: 'webhook',
        reason:   `webhook_throw: ${e instanceof Error ? e.message : String(e)}`,
        png_diagnostic: pngDiag,
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
    png_diagnostic: pngDiag,
    payload,
    summary,
  }
}
