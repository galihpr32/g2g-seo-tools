// ─── Forseti Slack notifications ───────────────────────────────────────────
//
// Sprint FORSETI.SLACK.ALERT — fire one Slack ping per sev-4+ new thread
// detected. Dedup window 24h via the forseti_thread_responses log so a
// flaky scraper re-inserting the same row doesn't double-alert.

import type { SupabaseClient } from '@supabase/supabase-js'
import { postSlackRouted } from '@/lib/slack/routing'

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? ''

/**
 * Fire Slack alerts for the given thread IDs. Resolves the routed webhook
 * per (owner × site), so G2G threads ping the G2G channel and OffGamers
 * threads ping the OG channel.
 *
 * Returns silently — alert failures are not surfaced to the scraper caller
 * since the threads are already persisted.
 */
export async function fireForsetiSevereAlerts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>,
  threadIds: string[],
): Promise<void> {
  if (!Array.isArray(threadIds) || threadIds.length === 0) return

  const { data: threads, error } = await db
    .from('forseti_threads')
    .select('id, owner_user_id, site_slug, reddit_url, subreddit, thread_title, op_post_score, op_comment_count, auto_severity, manual_severity_override, auto_category, manual_category_override, op_username, op_post_at')
    .in('id', threadIds)
  if (error || !threads) return

  // Dedup — skip threads that already have a forseti_alert log entry in the
  // past 24h. Log row uses response_type='internal_note' with a marker prefix.
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: existingLogs } = await db
    .from('forseti_thread_responses')
    .select('thread_id, response_text, created_at')
    .in('thread_id', threadIds)
    .eq('response_type', 'internal_note')
    .gte('created_at', dayAgoIso)
  const alreadyAlerted = new Set<string>()
  for (const log of (existingLogs ?? [])) {
    if (typeof log.response_text === 'string' && log.response_text.startsWith('[forseti-alert]')) {
      alreadyAlerted.add(log.thread_id as string)
    }
  }

  for (const t of threads) {
    if (alreadyAlerted.has(t.id as string)) continue
    const sev = (t.manual_severity_override ?? t.auto_severity) as number
    const cat = (t.manual_category_override ?? t.auto_category) as string

    const sevIcon = sev >= 5 ? '🔥' : '⚠'
    const ownerId  = t.owner_user_id as string
    const siteSlug = t.site_slug as string

    const internalUrl = APP_BASE_URL ? `${APP_BASE_URL}/forseti/${t.id}` : `/forseti/${t.id}`

    const payload = {
      text: `${sevIcon} New sev-${sev} thread spotted: ${t.thread_title}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${sevIcon} Forseti — Sev-${sev} ${cat}`, emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*<${t.reddit_url}|${escapeMrkdwn(String(t.thread_title).slice(0, 200))}>*\n_r/${t.subreddit}${t.op_username ? ` · u/${t.op_username}` : ''}_`,
          },
        },
        {
          type: 'context',
          elements: [
            { type: 'mrkdwn', text: `📈 *${t.op_post_score}* upvotes` },
            { type: 'mrkdwn', text: `💬 *${t.op_comment_count}* comments` },
            { type: 'mrkdwn', text: `🏷 ${cat}` },
            { type: 'mrkdwn', text: `🕐 ${t.op_post_at ? new Date(t.op_post_at as string).toLocaleString() : 'just now'}` },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Open on Reddit', emoji: true },
              url:  t.reddit_url,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Triage in Forseti', emoji: true },
              url:  internalUrl,
            },
          ],
        },
      ],
    }

    // Fire alert
    try {
      const res = await postSlackRouted(db, ownerId, 'forseti_severe', payload, { siteSlug })
      if (res?.ok) {
        // Log the alert so future re-polls don't duplicate
        await db.from('forseti_thread_responses').insert({
          thread_id:     t.id,
          owner_user_id: ownerId,
          response_type: 'internal_note',
          response_text: `[forseti-alert] Sev-${sev} ${cat} alert fired to Slack`,
        })
      } else {
        console.warn(`[forseti-slack] webhook unreachable for thread ${t.id} (status ${res?.status})`)
      }
    } catch (err) {
      console.warn(`[forseti-slack] alert send failed for thread ${t.id}:`, err instanceof Error ? err.message : String(err))
    }
  }
}

function escapeMrkdwn(text: string): string {
  return text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!))
}
