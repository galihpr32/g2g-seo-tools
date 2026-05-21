// ── Slack file upload helper (PNG/binary attachments) ─────────────────────
//
// Sprint FRIDAY.KPI.GRAPH.5 — Slack incoming webhooks can't attach files,
// so to deliver a PNG digest we go through the modern files.uploadV2 flow:
//
//   1. files.getUploadURLExternal  → returns a one-shot upload URL + file_id
//   2. PUT the bytes to that URL
//   3. files.completeUploadExternal → finalize + (optionally) share to channel
//
// Requires SLACK_BOT_TOKEN with scope `files:write` and `chat:write`. If
// either the token or the channel ID is missing, callers should fall back
// to webhook delivery.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NotificationType } from './routing'

const SLACK_API = 'https://slack.com/api'

export interface PostPngOpts {
  buffer:           Buffer
  filename:         string         // e.g. 'friday-kpi-2026-W21.png'
  channelId:        string         // e.g. 'C01234ABCDE'
  initialComment?:  string         // posted as the message body next to the file
  title?:           string         // file title shown in Slack
}

export interface PostPngResult {
  ok:        boolean
  status:    number
  file_id?:  string
  error?:    string
}

/**
 * Upload a PNG (or any binary) to Slack via files.uploadV2 and share it to a
 * channel. Returns the file_id when successful.
 */
export async function postPngToSlack(opts: PostPngOpts): Promise<PostPngResult> {
  const token = process.env.SLACK_BOT_TOKEN
  if (!token) return { ok: false, status: 0, error: 'no_slack_bot_token' }
  if (!opts.channelId) return { ok: false, status: 0, error: 'no_channel_id' }

  try {
    // 1. Get a one-shot upload URL
    const length = opts.buffer.byteLength
    const getUrlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: opts.filename,
        length:   String(length),
      }),
    })
    const getUrlJson = await getUrlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }
    if (!getUrlJson.ok || !getUrlJson.upload_url || !getUrlJson.file_id) {
      return { ok: false, status: getUrlRes.status, error: `getUploadURLExternal: ${getUrlJson.error ?? 'unknown'}` }
    }

    // 2. PUT the bytes
    const putRes = await fetch(getUrlJson.upload_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body:    new Uint8Array(opts.buffer),
    })
    if (!putRes.ok) {
      return { ok: false, status: putRes.status, error: `upload_put_failed_${putRes.status}` }
    }

    // 3. Finalize + share to channel
    const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        files: [{
          id:    getUrlJson.file_id,
          title: opts.title ?? opts.filename,
        }],
        channel_id:      opts.channelId,
        initial_comment: opts.initialComment ?? '',
      }),
    })
    const completeJson = await completeRes.json() as { ok: boolean; error?: string }
    if (!completeJson.ok) {
      return { ok: false, status: completeRes.status, error: `completeUploadExternal: ${completeJson.error ?? 'unknown'}` }
    }

    return { ok: true, status: 200, file_id: getUrlJson.file_id }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Resolve the Slack channel ID for a given notification type (mirrors
 * resolveSlackWebhook). Returns null if no channel is configured.
 */
export async function resolveSlackChannelId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  type:    NotificationType,
  opts:    { siteSlug?: string | null } = {},
): Promise<string | null> {
  try {
    const { data } = await db
      .from('slack_routing_config')
      .select('site_slug, slack_channel_id, enabled')
      .eq('owner_user_id', ownerId)
      .eq('notification_type', type)
      .eq('enabled', true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]

    if (opts.siteSlug) {
      const specific = rows.find(r => r.site_slug === opts.siteSlug)
      if (specific?.slack_channel_id) return String(specific.slack_channel_id)
    }
    const agnostic = rows.find(r => r.site_slug === null)
    if (agnostic?.slack_channel_id) return String(agnostic.slack_channel_id)
  } catch {
    /* fall through */
  }
  return null
}
