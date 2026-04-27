import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServiceClient } from '@/lib/supabase/service'
import { executeAction, type AgentAction } from '@/lib/agents/executor'

export const maxDuration = 30

/**
 * POST /api/slack/interactive
 *
 * Receives Slack Block Kit button clicks (Approve / Reject on agent_actions).
 *
 * Slack app config required (one-time):
 *   - https://api.slack.com/apps → app → Interactivity & Shortcuts
 *   - Enable Interactivity → Request URL = https://APP/api/slack/interactive
 *   - Save + reinstall app
 *
 * Auth: HMAC-SHA256 verification using SLACK_SIGNING_SECRET (no user session).
 *
 * Behaviour:
 *   - "Approve" button → calls executor.executeAction (same path as UI)
 *   - "Reject" button  → flips agent_action.status = 'rejected'
 *   - "View" button    → handled by Slack (just opens URL)
 *   - Replaces the original message in-place with the action's buttons
 *     replaced by a "✅ Approved by @user" status line.
 *   - Idempotent: if action already actioned by someone else, returns
 *     ephemeral "already X by Y" without re-executing.
 */
export async function POST(req: Request) {
  // ── 1. Read raw body for signature verification ────────────────────────────
  const rawBody = await req.text()
  const signingSecret = process.env.SLACK_SIGNING_SECRET ?? ''

  if (!signingSecret) {
    return NextResponse.json({ error: 'SLACK_SIGNING_SECRET not configured' }, { status: 500 })
  }

  if (!verifySlackSignature(req.headers, rawBody, signingSecret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // ── 2. Parse payload (Slack sends application/x-www-form-urlencoded with
  //       a single `payload` field containing JSON) ───────────────────────────
  const params = new URLSearchParams(rawBody)
  const payloadStr = params.get('payload')
  if (!payloadStr) {
    return NextResponse.json({ error: 'Missing payload' }, { status: 400 })
  }

  let payload: SlackInteractivePayload
  try {
    payload = JSON.parse(payloadStr) as SlackInteractivePayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 })
  }

  if (payload.type !== 'block_actions') {
    // Other payload types we don't handle yet — acknowledge silently
    return NextResponse.json({ ok: true })
  }

  const action = payload.actions?.[0]
  if (!action || !action.action_id) {
    return NextResponse.json({ error: 'Missing action' }, { status: 400 })
  }

  const slackUser = payload.user?.username || payload.user?.name || payload.user?.id || 'someone'

  // ── 3. Match action_id pattern ─────────────────────────────────────────────
  // Block-Kit action_ids we issue: "approve_<uuid>" | "reject_<uuid>" | "view_action_<uuid>"
  const approveMatch = /^approve_(.+)$/.exec(action.action_id)
  const rejectMatch  = /^reject_(.+)$/.exec(action.action_id)

  if (!approveMatch && !rejectMatch) {
    // view_* and other non-action buttons handled by Slack itself
    return NextResponse.json({ ok: true })
  }

  const decision  = approveMatch ? 'approve' : 'reject'
  const actionId  = (approveMatch ?? rejectMatch)![1]
  const db        = createServiceClient()

  // ── 4. Look up the agent_action ────────────────────────────────────────────
  const { data: row, error: lookupErr } = await db
    .from('agent_actions')
    .select('*')
    .eq('id', actionId)
    .maybeSingle()

  if (lookupErr) {
    console.error('[slack/interactive] lookup failed:', lookupErr)
    return ephemeral(`Database error: ${lookupErr.message}`)
  }
  if (!row) {
    return ephemeral(`Action no longer exists (id ${actionId.slice(0, 8)}…)`)
  }

  // Idempotency — already actioned
  if (row.status !== 'pending') {
    const who = row.approved_by ? `<@${row.approved_by}>` : 'someone'
    return ephemeral(`This action was already ${row.status} by ${who} — refresh the message to see the latest state.`)
  }

  // ── 5. Execute decision ────────────────────────────────────────────────────
  if (decision === 'approve') {
    const result = await executeAction(row as AgentAction, row.owner_user_id)
    if (!result.ok) {
      console.error('[slack/interactive] approve failed:', result.error)
      return ephemeral(`Approval executed but failed: ${result.error ?? 'unknown error'}`)
    }
  } else {
    const { error: rejectErr } = await db
      .from('agent_actions')
      .update({
        status:      'rejected',
        approved_at: new Date().toISOString(),
        approved_by: row.owner_user_id,   // record owner as actor (Slack user-id mapping is out of scope)
      })
      .eq('id', actionId)
    if (rejectErr) {
      console.error('[slack/interactive] reject failed:', rejectErr)
      return ephemeral(`Reject failed: ${rejectErr.message}`)
    }
  }

  // ── 6. Build updated message: same blocks, but replace the matching
  //       action's button-row with a status context line ────────────────────
  const originalBlocks = (payload.message?.blocks ?? []) as Block[]
  const verb = decision === 'approve' ? 'Approved' : 'Rejected'
  const icon = decision === 'approve' ? '✅' : '❌'
  const updatedBlocks = transformBlocksAfterAction(originalBlocks, actionId, `${icon} ${verb} by @${slackUser} · just now`)

  return NextResponse.json({
    replace_original: true,
    blocks:           updatedBlocks,
  })
}

// ── Helpers ─────────────────────────────────────────────────────────────────-

function verifySlackSignature(headers: Headers, rawBody: string, secret: string): boolean {
  const ts  = headers.get('x-slack-request-timestamp')
  const sig = headers.get('x-slack-signature')
  if (!ts || !sig) return false

  // Reject requests older than 5 minutes (replay protection)
  const tsNum = parseInt(ts, 10)
  if (Number.isNaN(tsNum)) return false
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false

  const baseString = `v0:${ts}:${rawBody}`
  const expected   = 'v0=' + crypto.createHmac('sha256', secret).update(baseString).digest('hex')

  // Constant-time compare
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function ephemeral(text: string) {
  return NextResponse.json({ response_type: 'ephemeral', text })
}

interface Block {
  type:       string
  block_id?:  string
  // Permissive: Slack block elements vary widely; we only inspect action_id
  // when present, but allow other shapes (e.g. context blocks have text).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  elements?:  Array<any>
  text?:      { type: string; text: string }
  [k: string]: unknown
}

/**
 * Walk the message blocks and:
 *   - remove the actions-block whose buttons reference the matched actionId
 *   - inject a context block in its place with the status text
 * Other blocks are kept verbatim so the rest of the message stays readable.
 */
function transformBlocksAfterAction(
  blocks: Block[],
  actionId: string,
  statusText: string,
): Block[] {
  const out: Block[] = []
  for (const b of blocks) {
    // The actions-block we issue has elements[].action_id like "approve_xxx" / "reject_xxx"
    if (b.type === 'actions' && Array.isArray(b.elements)) {
      const hasOurAction = b.elements.some(el =>
        typeof el.action_id === 'string' &&
        (el.action_id === `approve_${actionId}` || el.action_id === `reject_${actionId}`)
      )
      if (hasOurAction) {
        // Replace with a status context block
        out.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: statusText }],
        } as Block)
        continue
      }
    }
    out.push(b)
  }
  return out
}

// ── Slack payload types (subset we care about) ──────────────────────────────-
interface SlackInteractivePayload {
  type:        string
  user?:       { id?: string; username?: string; name?: string }
  team?:       { id?: string }
  actions?:    Array<{ action_id: string; value?: string; type?: string }>
  response_url?: string
  message?:    { blocks?: unknown[]; ts?: string }
}
