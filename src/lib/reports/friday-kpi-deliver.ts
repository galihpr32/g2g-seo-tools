// ── Friday KPI delivery (Slack PNG with webhook fallback) ─────────────────
//
// Sprint FRIDAY.KPI.GRAPH.5 — PNG upload (files.uploadV2) with webhook
// fallback. Both modes now include Public Report + Methodology action
// buttons (Sprint FRIDAY.KPI.SLACK-BUTTONS).

import type { SupabaseClient } from '@supabase/supabase-js'
import { buildFridayKpi, buildPngOverviewComment, type FridayKpiPayload } from './friday-kpi'
import { buildActionPlan } from './action-plan-synthesizer'
import { renderFridayKpiHtml, type AiVisibilityHistory } from './friday-kpi-html'
import { htmlToPng } from './puppeteer-launcher'
import { resolveSlackWebhook } from '@/lib/slack/routing'
import { resolveSlackChannelId, postPngToSlack } from '@/lib/slack/files'

/**
 * Sprint FRIDAY.KPI.PNG-UNSPLIT — load the last N days of Bing AI snapshots
 * per brand so the PNG renderer can draw a multi-line citations chart. If
 * no rows exist (Galih hasn't imported yet), returns empty arrays per brand
 * and the renderer just omits the chart section gracefully.
 */
async function loadAiVisibilityHistory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
  days:      number,
): Promise<AiVisibilityHistory> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const { data } = await db
    .from('ai_visibility_snapshots')
    .select('site_slug, snapshot_date, citations, cited_pages, llm_source')
    .eq('owner_user_id', ownerId)
    .in('site_slug', siteSlugs)
    .eq('llm_source', 'bing_ai')
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[]

  const perBrand: AiVisibilityHistory = {}
  for (const slug of siteSlugs) perBrand[slug] = { dates: [], citations: [], cited_pages: [] }
  for (const r of rows) {
    const slug = String(r.site_slug)
    const bucket = perBrand[slug]
    if (!bucket) continue
    bucket.dates.push(String(r.snapshot_date))
    bucket.citations.push(Number(r.citations  ?? 0))
    bucket.cited_pages.push(Number(r.cited_pages ?? 0))
  }
  return perBrand
}

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

  // 3. Try PNG upload first — Sprint FRIDAY.KPI.PNG-UNSPLIT reverts to a
  // single combined PNG (the 3-PNG split looked unbalanced because each
  // sub-image got rendered at full viewport height regardless of content).
  // One image, one upload, one Slack message — auto-sized via puppeteer's
  // fullPage: true.
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

      // Fetch historical AI visibility data (last 84 days, bing_ai source)
      // for the chart inside the PNG. Returns empty array if no data yet.
      const aiHistory = await loadAiVisibilityHistory(db, ownerId, siteSlugs, 84)

      const html = renderFridayKpiHtml({ payload, actionPlans, aiHistory })
      const png  = await htmlToPng(html)

      const overview = buildPngOverviewComment(payload)
      const links    = buildInlineLinks(payload)
      const comment  = links ? `${overview}\n${links}` : overview

      const up = await postPngToSlack({
        buffer:         png,
        filename:       `weekly-report-${week}.png`,
        channelId,
        initialComment: comment,
        title:          `Weekly Report · ${payload.week_label}`,
      })
      if (up.ok) {
        return {
          ok:          true,
          posted:      true,
          delivery:    'png_upload',
          slack_status: up.status,
          png_diagnostic: pngDiag,
          payload,
          summary,
        }
      }
      pngDiag.upload_error = up.error ?? `slack_${up.status}`
      console.warn('[friday-kpi deliver] PNG upload failed, falling back to webhook:', pngDiag.upload_error)
    } catch (e) {
      pngDiag.upload_error = e instanceof Error ? e.message : String(e)
      console.warn('[friday-kpi deliver] PNG render/upload threw, falling back to webhook:', pngDiag.upload_error)
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
