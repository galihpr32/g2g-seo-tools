// ─── Weekly report publisher ────────────────────────────────────────────
// Sprint WEEKLY.PUBLIC — composes the concise Slack message and dispatches
// via the multi-channel routing config. Used by:
//   - /api/reports/weekly/curate/publish (manual publish-now)
//   - /api/cron/weekly-report-publish    (Mon 08:00 UTC auto-publish sweep)
//
// Design pillars:
//   1. CONCISE — 3 sections: Headline, Tier status, Watch list, Priorities
//   2. BRAND-DISTINCT — red attachment stripe for G2G, blue for OffGamers
//   3. PUBLIC LINK — button to /public/weekly/[token] (login-free for CEOs)
//   4. CURATORIAL — curatorial_edits.JSONB overrides AI fields at publish time

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSlackWebhook } from '@/lib/slack/routing'

interface WeeklyReportRow {
  id:                string
  owner_user_id:     string
  site_slug:         string
  week_start:        string
  week_end:          string
  publish_status:    string
  public_token:      string | null
  ai_narrative:      string | null
  ai_action_plan:    string | null
  curatorial_edits:  Record<string, unknown> | null
  report_data:       Record<string, unknown> | null
  slack_ts:          string | null
}

interface GSCData {
  weekClicks?:        number
  weekImpressions?:   number
  avgPosition?:       number
  clicksPct?:         number
  impressionsPct?:    number
  topGainers?:        Array<{ page: string; delta: number }>
  topLosers?:         Array<{ page: string; delta: number }>
}

interface TierData {
  top3?:        number
  top10?:       number
  top3Delta?:   number
  top10Delta?:  number
  tier1AvgPos?: number
  tier2AvgPos?: number
}

interface DeliveryResult {
  ok:        boolean
  slack_ts?: string
  posted_to?: string
  notes:     string[]
}

const BRAND_STYLE: Record<string, { color: string; emoji: string; name: string }> = {
  g2g:       { color: '#DC2626', emoji: '🎯', name: 'G2G' },
  offgamers: { color: '#2563EB', emoji: '🕹️', name: 'OffGamers' },
}

/**
 * Publish a weekly report row to Slack via routed webhook.
 * - Applies curatorial_edits over AI-generated fields
 * - Includes Tier status section if tierStatus present in report_data
 * - Brand-distinct color stripe via Slack attachments wrapper
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deliverWeeklyReport(db: SupabaseClient<any, any, any>, report: WeeklyReportRow): Promise<DeliveryResult> {
  const notes: string[] = []

  const edits = (report.curatorial_edits ?? {}) as { narrative?: string; action_plan?: string; watch_list?: string[]; top_priorities?: string[] }
  const narrative   = edits.narrative   ?? report.ai_narrative   ?? ''
  const actionPlan  = edits.action_plan ?? report.ai_action_plan ?? ''
  const watchList   = edits.watch_list  ?? []
  const priorities  = edits.top_priorities ?? actionPlan.split('\n').filter(s => s.trim()).slice(0, 3)

  const rd          = (report.report_data ?? {}) as Record<string, unknown>
  const gsc         = (rd.gsc as GSCData) ?? {}
  const tier        = (rd.tierStatus as TierData) ?? {}
  const weekLabel   = (rd.weekLabel as string) ?? formatWeekLabel(report.week_start, report.week_end)
  const brand       = BRAND_STYLE[report.site_slug] ?? BRAND_STYLE.g2g

  const appUrl    = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  const publicUrl = report.public_token ? `${appUrl}/public/weekly/${report.public_token}` : null
  const dashUrl   = `${appUrl}/${report.site_slug}/reports/weekly?id=${report.id}`

  // ── Compose blocks ───────────────────────────────────────────────────
  const blocks: unknown[] = []

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `${brand.emoji} ${brand.name} — Weekly Report | ${weekLabel}`, emoji: true },
  })

  // The headline (4 KPIs in one section)
  const headlineLines = [
    `🎯 *The headline*`,
    gsc.weekClicks      != null ? `   • Clicks: *${fmtNum(gsc.weekClicks)}*${fmtPct(gsc.clicksPct)}`                                : null,
    gsc.weekImpressions != null ? `   • Impressions: *${fmtNum(gsc.weekImpressions)}*${fmtPct(gsc.impressionsPct)}`                  : null,
    gsc.avgPosition     != null ? `   • Avg position: *#${gsc.avgPosition.toFixed(1)}*`                                              : null,
    gsc.topGainers?.[0]         ? `   • Top mover: \`${trimPath(gsc.topGainers[0].page)}\` (+${fmtNum(gsc.topGainers[0].delta)} clicks)` : null,
  ].filter(Boolean).join('\n')
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: headlineLines } })

  // Tier status (only if data present)
  if (tier.top3 != null || tier.top10 != null) {
    const tierLines = [
      `🥇 *Tier status*`,
      tier.top3        != null ? `   • Top 3:  *${tier.top3}* keywords${fmtDelta(tier.top3Delta, ' wow')}`         : null,
      tier.top10       != null ? `   • Top 10: *${tier.top10}* keywords${fmtDelta(tier.top10Delta, ' wow')}`       : null,
      tier.tier1AvgPos != null ? `   • Tier 1 avg: *#${tier.tier1AvgPos.toFixed(1)}*`                              : null,
      tier.tier2AvgPos != null ? `   • Tier 2 avg: *#${tier.tier2AvgPos.toFixed(1)}*`                              : null,
    ].filter(Boolean).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: tierLines } })
  }

  // Watch list (only if items exist)
  if (watchList.length > 0) {
    const watchLines = [
      `⚠️ *Watch list — ${watchList.length} item${watchList.length === 1 ? '' : 's'}*`,
      ...watchList.slice(0, 3).map(w => `   • ${w}`),
      watchList.length > 3 ? `   _…${watchList.length - 3} more in dashboard_` : null,
    ].filter(Boolean).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: watchLines } })
  }

  // Next week priorities
  if (priorities.length > 0) {
    const top = priorities.slice(0, 3)
    const priorityLines = [
      `✅ *Next week — top ${top.length} priorit${top.length === 1 ? 'y' : 'ies'}*`,
      ...top.map((p, i) => `   ${i + 1}. ${p}`),
    ].join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: priorityLines } })
  }

  // Actions row — public link + dashboard
  const actionElements: unknown[] = []
  if (publicUrl) actionElements.push({ type: 'button', text: { type: 'plain_text', text: '📄 View Full Report' }, url: publicUrl, style: 'primary' })
  actionElements.push({ type: 'button', text: { type: 'plain_text', text: '🎯 Priority Products' }, url: `${appUrl}/${report.site_slug}/priority-products` })
  if (dashUrl !== publicUrl) actionElements.push({ type: 'button', text: { type: 'plain_text', text: '✏️ Edit (team)' }, url: dashUrl })
  if (actionElements.length > 0) {
    blocks.push({ type: 'actions', elements: actionElements })
  }

  // Narrative as collapsed thread-style context (compact)
  if (narrative) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${truncate(narrative.split('\n').filter(Boolean)[0] ?? '', 200)}_` }],
    })
  }

  // ── Resolve webhook + post ───────────────────────────────────────────
  const webhookUrl = await resolveSlackWebhook(db, report.owner_user_id, 'weekly_report', { siteSlug: report.site_slug })
  if (!webhookUrl) {
    notes.push('No Slack webhook resolved (config + env both empty)')
    return { ok: false, notes }
  }

  // Wrap in attachments to get brand-color stripe on the left
  const payload = {
    attachments: [
      {
        color: brand.color,
        blocks,
      },
    ],
  }

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    if (!res.ok) {
      notes.push(`Slack POST ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return { ok: false, notes }
    }
    return { ok: true, notes, posted_to: webhookUrl === process.env.SLACK_WEBHOOK_URL ? 'env' : 'config' }
  } catch (e) {
    notes.push(`Slack POST exception: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, notes }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function fmtNum(n?: number | null): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toLocaleString()
}
function fmtPct(pct?: number | null): string {
  if (pct == null) return ''
  const sign  = pct >= 0 ? '+' : ''
  const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→'
  return ` (${arrow}${sign}${Math.round(pct)}% wow)`
}
function fmtDelta(delta?: number | null, suffix = ''): string {
  if (delta == null || delta === 0) return ''
  const sign  = delta > 0 ? '+' : ''
  const arrow = delta > 0 ? '↑' : '↓'
  return ` ${arrow} ${sign}${delta}${suffix}`
}
function trimPath(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40)
}
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}
function formatWeekLabel(start: string, end: string): string {
  const s = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const e = new Date(end).toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}
