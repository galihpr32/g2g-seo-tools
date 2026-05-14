// ─── Real-time tech-debt INSERT alert ──────────────────────────────────
// Sprint TECH.REALTIME — fires immediate Slack when a new high/critical
// priority seo_action_items row is created. Routes via slack_routing_config
// under 'daily_alerts'. Sets last_escalated_at to avoid double-firing in
// the weekly digest.
//
// Callers: any code path that inserts seo_action_items rows. Call
// AFTER the insert succeeds — pass the returned row(s).

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSlackWebhook } from '@/lib/slack/routing'

interface ActionItem {
  id:            string
  owner_user_id?: string | null
  site_slug?:    string | null
  page?:         string | null
  title:         string
  action_type?:  string | null
  priority?:     string | null
  status?:       string | null
  created_at?:   string
}

const PRIORITIES_TO_ESCALATE = new Set(['high', 'critical'])

/**
 * Fire immediate Slack for any item with priority high/critical.
 * Items below threshold are ignored (will surface in weekly digest only).
 * Best-effort: swallows all errors so it never blocks the upstream insert.
 */
export async function maybeAlertTechItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  item: ActionItem,
): Promise<{ alerted: boolean; reason?: string }> {
  try {
    const priority = String(item.priority ?? '').toLowerCase()
    if (!PRIORITIES_TO_ESCALATE.has(priority)) {
      return { alerted: false, reason: 'priority_below_threshold' }
    }
    if (!item.owner_user_id) {
      return { alerted: false, reason: 'no_owner' }
    }

    const webhookUrl = await resolveSlackWebhook(
      db,
      item.owner_user_id,
      'daily_alerts',
      { siteSlug: item.site_slug ?? undefined },
    )
    if (!webhookUrl) return { alerted: false, reason: 'no_webhook' }

    const siteSlug = (item.site_slug ?? 'g2g').toLowerCase()
    const style = siteSlug === 'offgamers'
      ? { color: '#2563EB', emoji: '🕹️', brand: 'OffGamers' }
      : { color: '#DC2626', emoji: '🎯', brand: 'G2G' }
    const pri = priority === 'critical' ? '🚨 CRITICAL' : '⚠️ HIGH'
    const pagePath = item.page
      ? String(item.page).replace(/^https?:\/\/[^/]+/, '').slice(0, 80)
      : '(no page)'

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${style.emoji} ${style.brand} — New ${priority.toUpperCase()} Tech Item`, emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*${pri}* · ${item.title}`,
            `*Type:* \`${item.action_type ?? 'n/a'}\``,
            `*Page:* \`${pagePath}\``,
          ].join('\n'),
        },
      },
      ...(process.env.NEXT_PUBLIC_APP_URL ? [{
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: '🛠 Open action item' },
          url:  `${(process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '')}/gsc/action-items/${item.id}`,
          style: 'primary',
        }],
      }] : []),
    ]

    const slackRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ attachments: [{ color: style.color, blocks }] }),
    })

    if (slackRes.ok) {
      // Stamp the row so weekly digest knows this was already alerted
      await db
        .from('seo_action_items')
        .update({ last_escalated_at: new Date().toISOString() })
        .eq('id', item.id)
      return { alerted: true }
    }
    return { alerted: false, reason: `slack_${slackRes.status}` }
  } catch (e) {
    console.warn('[tech-item-alert] fire failed:', e instanceof Error ? e.message : e)
    return { alerted: false, reason: 'exception' }
  }
}

/**
 * Convenience: alert multiple items inserted at once (e.g. bulk insert).
 * Calls maybeAlertTechItem for each. Parallel, swallow individual errors.
 */
export async function maybeAlertTechItems(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  items: ActionItem[],
): Promise<{ alerted_count: number }> {
  if (items.length === 0) return { alerted_count: 0 }
  const results = await Promise.allSettled(items.map(i => maybeAlertTechItem(db, i)))
  const alerted = results.filter(r => r.status === 'fulfilled' && r.value.alerted).length
  return { alerted_count: alerted }
}
