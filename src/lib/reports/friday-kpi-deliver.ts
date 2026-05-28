// ── Friday KPI delivery (Slack PNG with webhook fallback) ─────────────────
//
// Sprint FRIDAY.KPI.GRAPH.5 — PNG upload (files.uploadV2) with webhook
// fallback. Both modes now include Public Report + Methodology action
// buttons (Sprint FRIDAY.KPI.SLACK-BUTTONS).
//
// Sprint WEEKLY.SLACK.PUBLIC-PNG — three-button layout now (Public Detailed
// Report + PNG File primaries, Methodology secondary). Before posting, the
// deliver function:
//   1. Refreshes weekly_reports for each active site for the current week
//      so the public detail page never shows stale data
//   2. Writes the rendered PNG bytes to the G2G row so /public/weekly/png/
//      latest can serve them without auth

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
export async function loadAiVisibilityHistory(
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
    /** Sprint WEEKLY.SLACK.PUBLIC-PNG — diagnostics for the
     *  attach-PNG-to-weekly_reports step. Helps debug when
     *  /public/weekly/png/latest returns "No PNG yet" even after a fire. */
    weekly_refresh_errors?: string[]
    token_by_brand?:        Record<string, string | null>
    attach_attempted?:      boolean
    attach_token?:          string | null
    attach_ok?:             boolean
    attach_error?:          string
    png_size_bytes?:        number
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
 * Sprint WEEKLY.SLACK.PUBLIC-PNG — three-button layout. The two primaries
 * (Public Detailed Report + PNG File) sit in the actions block. Methodology
 * moves to a context block below so the visual hierarchy matches "two
 * things to read · one reference link", per Galih's spec.
 *
 * Returns up to TWO blocks: the actions row + an optional methodology
 * context row. Caller spreads them into the blocks array.
 */
function buildActionBlocks(payload: FridayKpiPayload): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []

  // Primary actions row — only render when at least one URL exists.
  const primary: Array<Record<string, unknown>> = []
  if (payload.public_url) {
    primary.push({
      type:  'button',
      text:  { type: 'plain_text', text: '📄 Public Detailed Report', emoji: true },
      url:   payload.public_url,
      style: 'primary',
    })
  }
  if (payload.png_url) {
    primary.push({
      type:  'button',
      text:  { type: 'plain_text', text: '🖼️ PNG File', emoji: true },
      url:   payload.png_url,
      style: 'primary',
    })
  }
  if (primary.length > 0) {
    out.push({ type: 'actions', elements: primary })
  }

  // Secondary reference link in a context block below — smaller, dimmed,
  // matches the "this is just a reference" intent.
  if (payload.methodology_url) {
    out.push({
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🎯 <${payload.methodology_url}|Methodology>` },
      ],
    })
  }
  return out
}

/**
 * Build the inline link string for PNG mode initial_comment. files.uploadV2
 * only supports plain text initial_comment, so we use Slack markdown link
 * syntax `<url|label>`. Two primary links on the top row, methodology on a
 * second line so it visually mirrors the Block Kit layout.
 */
function buildInlineLinks(payload: FridayKpiPayload): string {
  const top: string[] = []
  if (payload.public_url) top.push(`📄 <${payload.public_url}|Public Detailed Report>`)
  if (payload.png_url)    top.push(`🖼️ <${payload.png_url}|PNG File>`)
  const lines: string[] = []
  if (top.length > 0)            lines.push(top.join('  ·  '))
  if (payload.methodology_url)   lines.push(`🎯 <${payload.methodology_url}|Methodology>`)
  return lines.join('\n')
}

/**
 * Sprint WEEKLY.SLACK.PUBLIC-PNG — refresh the weekly_reports rows for the
 * current Thu→Wed window across both brands so the Public Detailed Report
 * button never lands on a stale (April) row. Calls /api/reports/weekly
 * POST with the cron-secret bearer, same pattern as
 * /api/cron/weekly-report-generator. Failures are isolated per brand and
 * don't abort the Slack delivery.
 *
 * Returns the public_token of the G2G row (default brand) so the caller
 * can attach png_data to it.
 */
async function refreshWeeklyReports(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  siteSlugs: string[],
): Promise<{ tokenByBrand: Record<string, string | null>; errors: string[] }> {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  const errors: string[] = []
  const tokenByBrand: Record<string, string | null> = {}

  if (!appUrl) {
    errors.push('NEXT_PUBLIC_APP_URL not set; cannot refresh weekly_reports')
    return { tokenByBrand, errors }
  }
  if (!process.env.CRON_SECRET) {
    errors.push('CRON_SECRET not set; cannot self-call /api/reports/weekly')
    return { tokenByBrand, errors }
  }

  // Parallel POST per brand. Each call generates/refreshes a weekly_reports
  // row for the current Thu→Wed window (route picks the default range when
  // body.week_start is omitted).
  await Promise.all(siteSlugs.map(async slug => {
    try {
      const res = await fetch(`${appUrl}/api/reports/weekly`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ owner_user_id: ownerId, site: slug }),
      })
      if (!res.ok) {
        // Surface the JSON `error` field (or first chunk of text) so the
        // manual trigger panel shows WHICH 400 we hit — without this all
        // we saw was a useless "returned 400" with no context.
        const text = await res.text().catch(() => '')
        let detail: string | undefined
        try { detail = (JSON.parse(text) as { error?: string }).error } catch { /* not json */ }
        const tail = detail ?? text.slice(0, 200)
        errors.push(`${slug}: /api/reports/weekly returned ${res.status}${tail ? ' — ' + tail : ''}`)
      }
    } catch (e) {
      errors.push(`${slug}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }))

  // Look up the freshly-saved tokens. Use week_start desc + first per brand
  // to grab the just-written row (current week).
  const { data: rows } = await db
    .from('weekly_reports')
    .select('site_slug, public_token, week_start')
    .eq('owner_user_id', ownerId)
    .in('site_slug', siteSlugs)
    .not('public_token', 'is', null)
    .order('week_start', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (rows ?? []) as any[]) {
    if (tokenByBrand[r.site_slug] === undefined) {
      tokenByBrand[r.site_slug] = String(r.public_token)
    }
  }
  // Fill in any missing brand with null so callers can iterate cleanly.
  for (const slug of siteSlugs) if (!(slug in tokenByBrand)) tokenByBrand[slug] = null

  return { tokenByBrand, errors }
}

/**
 * Sprint WEEKLY.SLACK.PUBLIC-PNG — persist the rendered PNG bytes to the
 * weekly_reports row for the given site_slug. Uses the just-resolved token
 * so we hit the freshly-published row, not some legacy April row. Also
 * stamps publish_status='published' + published_at=now() so the
 * /public/weekly/latest redirect prefers this row.
 *
 * Returns { ok, error? } so the caller can surface the failure in the
 * API response. Errors are logged but don't abort the Slack delivery —
 * the Slack post itself still happens even if the public PNG mirror fails.
 *
 * BYTEA encoding: supabase-js JSON-serializes whatever you pass to
 * .update(), which for a Buffer turns into {"type":"Buffer", data:[...]}
 * — PostgREST silently rejects that as bytea. Correct wire format is the
 * Postgres hex literal `\x<hex>`, which we build manually.
 */
async function attachPngToReport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:    SupabaseClient<any>,
  token: string,
  png:   Buffer,
): Promise<{ ok: boolean; error?: string }> {
  const hexLiteral = '\\x' + png.toString('hex')   // Postgres bytea hex format
  const { error } = await db
    .from('weekly_reports')
    .update({
      png_data:         hexLiteral,
      png_generated_at: new Date().toISOString(),
      publish_status:   'published',
      published_at:     new Date().toISOString(),
    })
    .eq('public_token', token)
  if (error) {
    console.warn('[friday-kpi deliver] attachPngToReport failed:', error.message)
    return { ok: false, error: error.message }
  }
  return { ok: true }
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
    channel_id_configured:  !!channelId,
    bot_token_present:      botTokenPresent,
    upload_attempted:       false,
    upload_error:           undefined as string | undefined,
    weekly_refresh_errors:  undefined as string[] | undefined,
    token_by_brand:         undefined as Record<string, string | null> | undefined,
    attach_attempted:       false,
    attach_token:           null as string | null,
    attach_ok:              false,
    attach_error:           undefined as string | undefined,
    png_size_bytes:         undefined as number | undefined,
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

  // Sprint WEEKLY.PNG.ALWAYS-ATTACH — refactor: PNG render + attach to DB
  // happens UNCONDITIONALLY now, regardless of whether Slack delivery uses
  // the PNG upload path or the webhook fallback. The public PNG mirror
  // (/public/weekly/png/latest) is the user-visible outcome — it should
  // work even on webhook-only setups (no channel ID configured).
  //
  // Order of operations:
  //   1. Kick off weekly_reports refresh in background
  //   2. Build action plans + AI history in parallel
  //   3. Render HTML → PNG
  //   4. Await refresh → resolve tokens
  //   5. Attach PNG bytes to G2G row (DB write)
  //   6. Try Slack delivery (PNG upload if configured, else webhook)
  let refreshErrors: string[] = []
  let tokenByBrand: Record<string, string | null> = {}
  const refreshPromise = refreshWeeklyReports(db, ownerId, siteSlugs).then(r => {
    refreshErrors = r.errors
    tokenByBrand  = r.tokenByBrand
  }).catch(e => {
    refreshErrors.push(`refresh threw: ${e instanceof Error ? e.message : String(e)}`)
  })

  // ── PNG render + attach (always-run block) ────────────────────────────
  let png:     Buffer | null = null
  const week:  string        = currentWeekIso()
  try {
    const actionPlans = await Promise.all(
      siteSlugs.map(async slug => ({
        brand: slug,
        plan:  await buildActionPlan({ db, ownerId, siteSlug: slug, weekIso: week }),
      })),
    )
    const aiHistory = await loadAiVisibilityHistory(db, ownerId, siteSlugs, 84)
    const html = renderFridayKpiHtml({ payload, actionPlans, aiHistory })
    png = await htmlToPng(html)
    pngDiag.png_size_bytes = png.length

    // Wait for refresh to finish so we have the freshly-published tokens
    await refreshPromise
    pngDiag.token_by_brand = tokenByBrand

    const g2gToken = tokenByBrand['g2g'] ?? tokenByBrand[siteSlugs[0] ?? ''] ?? null
    pngDiag.attach_token = g2gToken
    if (g2gToken) {
      pngDiag.attach_attempted = true
      const attachRes = await attachPngToReport(db, g2gToken, png)
      pngDiag.attach_ok    = attachRes.ok
      pngDiag.attach_error = attachRes.error
    }
  } catch (e) {
    // PNG render failed — Slack delivery can still proceed via webhook
    // fallback with text-only blocks. Log + carry on.
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[friday-kpi deliver] PNG render/attach threw:', msg)
    if (!pngDiag.attach_error) pngDiag.attach_error = `render: ${msg}`
  }

  // Settle refresh in case the render block failed before awaiting it
  await refreshPromise
  pngDiag.weekly_refresh_errors = refreshErrors.length > 0 ? refreshErrors : undefined
  if (refreshErrors.length > 0) {
    console.warn('[friday-kpi deliver] weekly_reports refresh issues:', refreshErrors.join(' | '))
  }

  // ── Slack delivery: PNG upload if configured, else webhook fallback ──
  if (channelId && botTokenPresent && png) {
    pngDiag.upload_attempted = true
    try {
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
      console.warn('[friday-kpi deliver] PNG upload threw, falling back to webhook:', pngDiag.upload_error)
    }
  }

  // 4. Webhook fallback — sends Block Kit message with overview section
  // + action buttons (Public Detailed Report + PNG File primaries +
  // Methodology context). Sprint WEEKLY.SLACK.PUBLIC-PNG drops the
  // "Open live dashboard" context line; outsiders now have a public PNG
  // route so there's no need to send them to the auth-gated dashboard.
  if (webhookUrl) {
    const overview = buildPngOverviewComment(payload, { withPng: false })

    const blocks: Array<Record<string, unknown>> = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: overview },
      },
    ]
    for (const b of buildActionBlocks(payload)) blocks.push(b)

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
