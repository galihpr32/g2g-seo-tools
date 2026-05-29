import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 10

// ─── POST /api/settings/slack-routing/test ──────────────────────────────────
// Fires a one-off "🟢 Test ping" message at a webhook URL the user pasted —
// proves the channel is reachable BEFORE saving. No DB write. Logged-in only.

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as {
    webhook_url?:        string
    notification_type?:  string
    channel_label?:      string
  }

  const url = String(body.webhook_url ?? '').trim()
  if (!url.startsWith('https://hooks.slack.com/')) {
    return NextResponse.json({ error: 'webhook_url must be a hooks.slack.com URL' }, { status: 400 })
  }

  const label = (body.channel_label ?? '').toString().slice(0, 60) || '(unlabelled)'
  const typeLabel = body.notification_type ? `\`${body.notification_type}\`` : 'this channel'

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🟢 Slack routing test ping', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `Confirmed — *${user.email ?? user.id}* routed a ${typeLabel} message to *${label}*.`,
          `If you see this, future notifications of this type will land here.`,
        ].join('\n'),
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Sent from /settings/slack-routing · ${new Date().toISOString().slice(0, 19)}Z` }],
    },
  ]

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks, text: 'Slack routing test ping' }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      return NextResponse.json({
        ok:     false,
        status: res.status,
        error:  errText.slice(0, 200) || `HTTP ${res.status}`,
      }, { status: 200 })
    }
    return NextResponse.json({ ok: true, status: res.status })
  } catch (e) {
    return NextResponse.json({
      ok:    false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 200 })
  }
}
