import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { computeAgentMetrics } from '@/lib/reports/agent-metrics'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 60

/**
 * GET /api/cron/agent-performance-weekly
 *
 * Sends a weekly digest to #team-marketing Slack with last 7 days of agent
 * activity: hours/$ saved, content shipped, agent breakdown.
 *
 * Schedule: Monday 09:00 WIB (= 02:00 UTC) — runs AFTER weekly report (01:00
 * UTC), so stakeholders see the AI digest right after their morning coffee.
 *
 * Auth: Bearer CRON_SECRET.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Iterate every (owner × site) that has any agent activity in last 14d
  const { data: owners } = await db
    .from('gsc_connections')
    .select('user_id')

  const uniqueOwners = Array.from(new Set((owners ?? []).map(o => o.user_id as string)))
  if (uniqueOwners.length === 0) return NextResponse.json({ message: 'No owners' })

  const { data: sites } = await db
    .from('site_configs')
    .select('slug, display_name')
    .eq('is_active', true)

  const activeSites = (sites ?? []) as Array<{ slug: string; display_name: string }>
  if (activeSites.length === 0) activeSites.push({ slug: 'g2g', display_name: 'G2G' })

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')
  let posted = 0
  const errors: string[] = []

  for (const ownerId of uniqueOwners) {
    for (const site of activeSites) {
      try {
        const metrics  = await computeAgentMetrics(db, ownerId, site.slug, 7)
        const prevMetrics = await computeAgentMetrics(db, ownerId, site.slug, 14)
        // Skip brands with zero activity
        if (metrics.cost.api_calls_total === 0 && metrics.content.briefs_total === 0 && metrics.content.product_content === 0) continue

        const fmt = (n: number) => n >= 10_000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toLocaleString()}`
        const fmtPct = (curr: number, prev: number): string => {
          const prevWindow = prev - curr
          if (prevWindow === 0) return curr > 0 ? ' (new)' : ''
          const pct = Math.round(((curr - prevWindow) / prevWindow) * 100)
          if (pct >= 0) return ` (↑${pct}% wow)`
          return ` (↓${Math.abs(pct)}% wow)`
        }

        const blocks: unknown[] = [
          {
            type: 'header',
            text: { type: 'plain_text', text: `🤖 ${site.display_name} — Weekly AI Agent Digest`, emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `*Net value:* ${fmt(metrics.net_value)} (${fmt(metrics.savings.total)} saved − ${fmt(metrics.cost.total)} API cost)`,
                `*Hours saved:* ${metrics.savings.hours_saved}h vs manual baseline`,
                ``,
                `📝 *Content shipped (7d)*`,
                `• Briefs: *${metrics.content.briefs_total}*${fmtPct(metrics.content.briefs_total, prevMetrics.content.briefs_total)}`,
                `• Product content: *${metrics.content.product_content}*${fmtPct(metrics.content.product_content, prevMetrics.content.product_content)}`,
                `• CMS uploads: *${metrics.content.product_content_uploaded}*${fmtPct(metrics.content.product_content_uploaded, prevMetrics.content.product_content_uploaded)}`,
                `• New opportunities: *${metrics.content.opportunities_total}*${fmtPct(metrics.content.opportunities_total, prevMetrics.content.opportunities_total)}`,
              ].join('\n'),
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [
                `🤖 *Agent activity*`,
                `• Heimdall: ${metrics.agents.heimdall.runs} runs, ${metrics.agents.heimdall.opportunities ?? 0} signals`,
                `• Odin: ${metrics.agents.odin.runs} runs, ${metrics.agents.odin.opportunities ?? 0} trends`,
                `• Loki: ${metrics.agents.loki.runs} runs, ${metrics.agents.loki.opportunities ?? 0} keyword gaps`,
                `• Bragi: ${metrics.content.briefs_total} briefs, ${metrics.agents.bragi.auto_approved ?? 0} auto-approved`,
                `• Tyr: ${metrics.agents.tyr.reviews ?? 0} reviewed (${metrics.agents.tyr.needs_review ?? 0} still need human review)`,
                `• Hermod: ${metrics.agents.hermod.runs} runs, ${metrics.agents.hermod.prospects_found ?? 0} prospects`,
                `• Bifrost: ${metrics.agents.bifrost.runs} runs, ${metrics.agents.bifrost.news_articles ?? 0} news articles, ${metrics.agents.bifrost.game_extractions ?? 0} game extractions`,
              ].join('\n'),
            },
          },
          appUrl ? {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: '📊 View full report' }, url: `${appUrl}/reports/agent-performance` },
              { type: 'button', text: { type: 'plain_text', text: '🎯 Priority products' }, url: `${appUrl}/priority-products` },
            ],
          } : null,
        ].filter(Boolean)

        // Sprint MULTI.3 — routed per-owner via slack_routing_config
        const webhookUrl = await resolveSlackWebhook(db, ownerId, 'agent_performance', { siteSlug: site.slug })
        if (!webhookUrl) {
          errors.push(`${ownerId}/${site.slug}: no webhook resolved (config + env both empty)`)
          continue
        }
        const slackRes = await fetch(webhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ blocks }),
        })
        if (slackRes.ok) posted++
        else errors.push(`${ownerId}/${site.slug}: Slack HTTP ${slackRes.status}`)
      } catch (e) {
        errors.push(`${ownerId}/${site.slug}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return NextResponse.json({ ok: errors.length === 0, posted, errors })
}
