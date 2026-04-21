/**
 * POST /api/slack/interact
 *
 * Handles Slack interactivity payloads (button clicks).
 * Verifies the request signature, then approves or rejects the agent action.
 */

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { executeAction, type AgentAction } from '@/lib/agents/executor'
import crypto from 'crypto'

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? ''
const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN ?? ''
const CHANNEL_ID     = process.env.SLACK_CHANNEL_ID ?? ''
const APP_URL        = process.env.NEXT_PUBLIC_APP_URL ?? 'https://g2g-seo-tools.vercel.app'

// ── Signature verification ────────────────────────────────────────────────────

async function verifySlackSignature(request: Request, body: string): Promise<boolean> {
  const timestamp  = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature  = request.headers.get('x-slack-signature') ?? ''

  // Reject if request is older than 5 minutes
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(timestamp)) > 300) return false

  const sigBase = `v0:${timestamp}:${body}`
  const hmac    = crypto.createHmac('sha256', SIGNING_SECRET)
  hmac.update(sigBase)
  const expected = `v0=${hmac.digest('hex')}`

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const rawBody = await request.text()

  // Verify Slack signature
  const valid = await verifySlackSignature(request, rawBody)
  if (!valid) {
    return new NextResponse('Unauthorized', { status: 401 })
  }

  // Slack sends payload as URL-encoded form
  const params  = new URLSearchParams(rawBody)
  const payload = JSON.parse(params.get('payload') ?? '{}') as SlackPayload

  if (payload.type !== 'block_actions') {
    return NextResponse.json({ ok: true })
  }

  const action   = payload.actions?.[0]
  const actionId = action?.action_id ?? ''
  const value    = action?.value ?? ''

  // Parse action: approve_{uuid} or reject_{uuid}
  const isApprove = actionId.startsWith('approve_')
  const isReject  = actionId.startsWith('reject_')

  if (!isApprove && !isReject) {
    return NextResponse.json({ ok: true })
  }

  const agentActionId = value
  const slackUserId   = payload.user?.id ?? 'slack'
  const messageTs     = payload.message?.ts ?? ''

  const db = createServiceClient()

  // Load the agent action
  const { data: agentAction } = await db
    .from('agent_actions')
    .select('*')
    .eq('id', agentActionId)
    .single()

  if (!agentAction || agentAction.status !== 'pending') {
    // Already handled — update the Slack message
    await updateMessage(messageTs, payload.message?.blocks ?? [], `⚠️ Action already processed.`)
    return NextResponse.json({ ok: true })
  }

  if (isReject) {
    await db
      .from('agent_actions')
      .update({ status: 'rejected', approved_by: null })
      .eq('id', agentActionId)

    await updateMessage(
      messageTs,
      replaceActionButtons(payload.message?.blocks ?? [], agentActionId, '❌ Rejected'),
      `❌ Action rejected by <@${slackUserId}>`
    )
    return NextResponse.json({ ok: true })
  }

  // Approve + execute
  await db
    .from('agent_actions')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', agentActionId)

  const result = await executeAction(agentAction as AgentAction, slackUserId)

  if (result.ok) {
    await updateMessage(
      messageTs,
      replaceActionButtons(payload.message?.blocks ?? [], agentActionId, '✅ Approved'),
      `✅ Action approved & executed by <@${slackUserId}>`
    )
  } else {
    await updateMessage(
      messageTs,
      replaceActionButtons(payload.message?.blocks ?? [], agentActionId, '⚠️ Error'),
      `⚠️ Execution failed: ${result.error}`
    )
  }

  return NextResponse.json({ ok: true })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function updateMessage(ts: string, blocks: unknown[], fallbackText: string) {
  if (!BOT_TOKEN || !CHANNEL_ID || !ts) return

  await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: CHANNEL_ID,
      ts,
      text:    fallbackText,
      blocks,
    }),
  })
}

// Replace the action buttons block for a given actionId with a status label
function replaceActionButtons(blocks: unknown[], actionId: string, label: string): unknown[] {
  return (blocks as Record<string, unknown>[]).map(block => {
    if (block.type !== 'actions') return block

    const elements = block.elements as { action_id?: string }[]
    const hasAction = elements.some(
      e => e.action_id === `approve_${actionId}` || e.action_id === `reject_${actionId}`
    )

    if (!hasAction) return block

    // Replace the entire actions block with a plain status text
    return {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${label} — <${APP_URL}/command-center|view dashboard>`,
      },
    }
  })
}

// ── Slack payload types ───────────────────────────────────────────────────────

interface SlackPayload {
  type:     string
  user?:    { id: string; name: string }
  actions?: { action_id: string; value: string }[]
  message?: { ts: string; blocks: unknown[] }
}
