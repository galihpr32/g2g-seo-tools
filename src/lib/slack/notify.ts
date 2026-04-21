/**
 * slack/notify.ts
 *
 * Sends agent run summary notifications to #writer-rangers via Slack Bot API.
 * Uses Block Kit for rich formatting + interactive Approve/Reject buttons.
 */

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentRunNotification {
  agentKey:      string
  agentLabel:    string
  agentEmoji:    string
  status:        'success' | 'error'
  summary:       string
  actionsQueued: number
  runId:         string
  appUrl:        string
  pendingActions: PendingAction[]
}

export interface PendingAction {
  id:          string
  title:       string
  description: string | null
  priority:    string
  actionType:  string
}

// ── Agent meta ────────────────────────────────────────────────────────────────

const AGENT_META: Record<string, { label: string; emoji: string }> = {
  'pak-rt':      { label: 'Pak RT',      emoji: '🔍' },
  'mas-gacor':   { label: 'Mas Gacor',   emoji: '📈' },
  'intel-bakso': { label: 'Intel Bakso', emoji: '🕵️' },
  'anak-intern': { label: 'Anak Intern', emoji: '✍️' },
  'kang-cilok':  { label: 'Kang Cilok',  emoji: '🤝' },
}

// ── Main notify function ──────────────────────────────────────────────────────

export async function notifyAgentRun(notif: AgentRunNotification): Promise<void> {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
    console.warn('[slack] Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID — skipping notification')
    return
  }

  const blocks = buildBlocks(notif)

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text:    `${notif.agentEmoji} *${notif.agentLabel}* finished — ${notif.summary}`,
      blocks,
    }),
  })

  const data = await res.json() as { ok: boolean; error?: string }
  if (!data.ok) {
    console.error('[slack] chat.postMessage failed:', data.error)
  }
}

// ── Update message after approve/reject ──────────────────────────────────────

export async function updateSlackMessage(
  ts: string,
  text: string,
  blocks: unknown[]
): Promise<void> {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) return

  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      ts,
      text,
      blocks,
    }),
  })
}

// ── Block Kit builder ─────────────────────────────────────────────────────────

function buildBlocks(notif: AgentRunNotification): unknown[] {
  const { agentEmoji, agentLabel, status, summary, actionsQueued, runId, appUrl, pendingActions } = notif

  const statusIcon  = status === 'success' ? '✅' : '❌'
  const queuedText  = actionsQueued > 0
    ? `*${actionsQueued} action${actionsQueued !== 1 ? 's' : ''}* queued for approval`
    : 'No actions queued'

  const blocks: unknown[] = [
    // Header
    {
      type: 'header',
      text: { type: 'plain_text', text: `${agentEmoji} ${agentLabel} — Run Complete`, emoji: true },
    },
    // Summary
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Status:*\n${statusIcon} ${status}` },
        { type: 'mrkdwn', text: `*Actions:*\n${queuedText}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Summary:*\n${summary}` },
    },
  ]

  // Show up to 3 pending actions with Approve/Reject buttons
  if (pendingActions.length > 0) {
    blocks.push({ type: 'divider' })
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Pending Actions:*` },
    })

    for (const action of pendingActions.slice(0, 3)) {
      const priorityEmoji = action.priority === 'high' ? '🔴' : action.priority === 'medium' ? '🟡' : '🟢'

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${priorityEmoji} *${action.title}*${action.description ? `\n${action.description.slice(0, 120)}${action.description.length > 120 ? '…' : ''}` : ''}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: '👁 View', emoji: true },
          url: `${appUrl}/command-center`,
          action_id: `view_action_${action.id}`,
        },
      })

      // Approve / Reject buttons
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve', emoji: true },
            style: 'primary',
            action_id: `approve_${action.id}`,
            value: action.id,
            confirm: {
              title: { type: 'plain_text', text: 'Approve this action?' },
              text: { type: 'mrkdwn', text: `*${action.title}*\nThis will execute the action immediately.` },
              confirm: { type: 'plain_text', text: 'Yes, approve' },
              deny: { type: 'plain_text', text: 'Cancel' },
            },
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Reject', emoji: true },
            style: 'danger',
            action_id: `reject_${action.id}`,
            value: action.id,
          },
        ],
      })
    }

    if (pendingActions.length > 3) {
      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `_+${pendingActions.length - 3} more action${pendingActions.length - 3 !== 1 ? 's' : ''} — <${appUrl}/command-center|view all in dashboard>_`,
        }],
      })
    }
  }

  // Footer with dashboard link
  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `<${appUrl}/command-center|Open Command Center> · Run ID: \`${runId}\``,
    }],
  })

  return blocks
}

// ── Helper: build notification from agent run result ─────────────────────────

export function buildAgentNotification(
  agentKey: string,
  runId: string,
  result: { summary: string; actionsQueued: number },
  pendingActions: PendingAction[],
  status: 'success' | 'error' = 'success'
): AgentRunNotification {
  const meta = AGENT_META[agentKey] ?? { label: agentKey, emoji: '🤖' }
  return {
    agentKey,
    agentLabel:    meta.label,
    agentEmoji:    meta.emoji,
    status,
    summary:       result.summary,
    actionsQueued: result.actionsQueued,
    runId,
    appUrl:        process.env.NEXT_PUBLIC_APP_URL ?? 'https://g2g-seo-tools.vercel.app',
    pendingActions,
  }
}
