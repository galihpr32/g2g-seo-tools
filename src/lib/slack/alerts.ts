import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSlackWebhook, type NotificationType } from '@/lib/slack/routing'

export interface SlackBlock {
  type: string
  [key: string]: unknown
}

// Sprint MULTI.3 — when callers can supply routing context, look up the
// per-(owner × site × type) webhook via slack_routing_config. Otherwise
// preserve original behaviour by falling back to env SLACK_WEBHOOK_URL.
export interface SlackRouteCtx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?:        SupabaseClient<any, any, any>
  ownerId?:   string
  type?:      NotificationType
  siteSlug?:  string | null
}

async function resolveWebhookForCtx(ctx?: SlackRouteCtx): Promise<string | null> {
  if (ctx?.db && ctx.ownerId && ctx.type) {
    const url = await resolveSlackWebhook(ctx.db, ctx.ownerId, ctx.type, { siteSlug: ctx.siteSlug ?? undefined })
    if (url && url !== 'placeholder') return url
  }
  const env = process.env.SLACK_WEBHOOK_URL
  if (!env || env === 'placeholder') return null
  return env
}

async function sendSlackMessage(blocks: SlackBlock[], text: string, ctx?: SlackRouteCtx) {
  const webhookUrl = await resolveWebhookForCtx(ctx)
  if (!webhookUrl) return false

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function sendRankingDropAlert(drops: {
  page: string
  clicksDrop: number
  impressionsDrop: number
  positionChange: number
  currentClicks: number
  previousClicks: number
}[], ctx?: SlackRouteCtx) {
  if (drops.length === 0) return

  const rows = drops.slice(0, 10).map(d =>
    `• *${new URL(d.page).pathname}* — Clicks ↓${Math.round(d.clicksDrop * 100)}% | Position ${d.positionChange > 0 ? '+' : ''}${d.positionChange.toFixed(1)}`
  ).join('\n')

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '📉 GSC Clicks Drop Alert' }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${drops.length} page(s) dropped >15% clicks WoW*\n${rows}`
      }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `📉 ${drops.length} pages lost >15% clicks WoW`, ctx)
}

export async function sendIndexCoverageAlert(data: {
  indexedPages: number
  previousIndexed: number
  errors: number
  previousErrors: number
}, ctx?: SlackRouteCtx) {
  const indexDrop = data.previousIndexed - data.indexedPages
  const newErrors = data.errors - data.previousErrors

  if (indexDrop < 50 && newErrors <= 0) return

  const lines = []
  if (indexDrop >= 50) lines.push(`• Indexed pages dropped by *${indexDrop}* (${data.previousIndexed} → ${data.indexedPages})`)
  if (newErrors > 0) lines.push(`• *${newErrors}* new crawl errors detected (total: ${data.errors})`)

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔍 GSC Index Coverage Alert' }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `🔍 GSC Index Coverage issue detected`, ctx)
}

export async function sendCWVAlert(degradations: {
  origin: string
  metric: string
  current: number
  previous: number
}[], ctx?: SlackRouteCtx) {
  if (degradations.length === 0) return

  const rows = degradations.map(d =>
    `• *${d.metric}* on ${d.origin} — Poor: ${Math.round(d.previous * 100)}% → ${Math.round(d.current * 100)}%`
  ).join('\n')

  return sendSlackMessage([
    {
      type: 'header',
      text: { type: 'plain_text', text: '⚡ Core Web Vitals Degradation' }
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${degradations.length} metric(s) degraded beyond threshold*\n${rows}` }
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')}` }]
    }
  ], `⚡ Core Web Vitals degradation detected`, ctx)
}
