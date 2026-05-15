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

// ─── Sprint GSC.T1.DOD — Tier-aware ranking drop alert ───────────────────────
// Splits the alert into urgency buckets so the on-call eye lands on T1
// drops first. T1 = day-over-day (most recent signal); T2/non-tier = WoW
// with 4-day lag (smoothed). Includes restriction_type so we don't get
// pinged about Genshin every Monday.
export interface TieredDropForAlert {
  page:              string
  clicksDrop:        number
  impressionsDrop:   number
  positionChange:    number
  currentClicks:     number
  previousClicks:    number
  currentPosition:   number
  previousPosition:  number
  tier:              1 | 2 | null
  comparison:        'day_over_day' | 'week_over_week'
  threshold_pct:     number
  product_name:      string | null
  restriction_type:  string | null
}

export async function sendTieredRankingDropAlert(
  drops: TieredDropForAlert[],
  thresholds: { t1_dod_pct: number; others_wow_pct: number; lag_days: number },
  ctx?:  SlackRouteCtx,
) {
  if (drops.length === 0) return

  const t1     = drops.filter(d => d.tier === 1)
  const t2     = drops.filter(d => d.tier === 2)
  const others = drops.filter(d => d.tier === null)

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📉 GSC Ranking Drops — Tier-aware', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*T1 (day-over-day ≥ ${thresholds.t1_dod_pct}%):* ${t1.length}`,
          `*T2 + others (WoW ≥ ${thresholds.others_wow_pct}%, ${thresholds.lag_days}-day lag):* ${t2.length + others.length}`,
        ].join('\n'),
      },
    },
  ]

  // T1 section — most urgent, full-fat formatting
  if (t1.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*🚨 Tier 1 — Day-over-Day drops (act today)*',
      },
    })
    for (const d of t1.slice(0, 8)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: formatTierRow(d) },
      })
    }
    if (t1.length > 8) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `…and ${t1.length - 8} more T1 drops` }],
      })
    }
  }

  // T2 + non-tier — terser
  const lower = [...t2, ...others]
  if (lower.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*⚠️ Tier 2 + non-tier — Week-over-Week (review when you can)*',
      },
    })
    const condensed = lower.slice(0, 10).map(d => {
      const path = safePath(d.page)
      const restr = d.restriction_type ? ` _(${d.restriction_type})_` : ''
      const tierLabel = d.tier === 2 ? 'T2 ' : ''
      return `• ${tierLabel}\`${path}\`${restr} — Clicks ↓${Math.round(d.clicksDrop * 100)}% | Pos ${formatPos(d)}`
    }).join('\n')
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: condensed },
    })
    if (lower.length > 10) {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `…and ${lower.length - 10} more` }],
      })
    }
  }

  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `G2G SEO Tools · ${new Date().toLocaleDateString('en-GB')} · ${thresholds.lag_days}-day GSC freshness lag applied to WoW window`,
    }],
  })

  const fallback = t1.length > 0
    ? `🚨 ${t1.length} T1 drops + ${lower.length} others`
    : `📉 ${lower.length} ranking drops detected`

  return sendSlackMessage(blocks, fallback, ctx)
}

function formatTierRow(d: TieredDropForAlert): string {
  const path  = safePath(d.page)
  const name  = d.product_name ? ` (${d.product_name})` : ''
  const restr = d.restriction_type
    ? `  _Note: ${d.restriction_type} restriction — drop may be expected_`
    : ''
  return [
    `• \`${path}\`${name}`,
    `   Clicks ↓${Math.round(d.clicksDrop * 100)}% (${d.previousClicks} → ${d.currentClicks}) · Pos ${formatPos(d)}${restr}`,
  ].join('\n')
}

function safePath(url: string): string {
  try { return new URL(url).pathname.slice(0, 80) } catch { return url.slice(0, 80) }
}

function formatPos(d: { currentPosition: number; previousPosition: number; positionChange: number }): string {
  if (!d.previousPosition || !d.currentPosition) return '—'
  const sign = d.positionChange > 0 ? '+' : ''
  return `#${d.previousPosition.toFixed(1)} → #${d.currentPosition.toFixed(1)} (${sign}${d.positionChange.toFixed(1)})`
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
