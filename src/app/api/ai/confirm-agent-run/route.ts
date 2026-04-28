import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 60

const VALID_AGENTS = new Set([
  'heimdall', 'loki', 'odin', 'bragi', 'hermod', 'saga', 'tyr', 'vor',
])

/**
 * POST /api/ai/confirm-agent-run
 *
 * Called by the AIAssistant "Yes, trigger" button. Validates the
 * one-time confirmation_token stored by propose_agent_run, then fires
 * the agent by delegating to the existing /api/agents/[key]/run endpoint.
 *
 * Why delegate rather than call runX() directly?
 * - The /api/agents/[key]/run endpoint owns the run-record lifecycle,
 *   config loading, and Slack notification. Reusing it keeps the
 *   logic in one place and avoids drift.
 * - We await the delegation so the run_id is available in the response.
 *   Agents have maxDuration=60 on their own endpoint; this endpoint
 *   inherits the 60s limit which is sufficient for all 8 agents.
 *
 * Token lifecycle:
 *   propose_agent_run (in chat/route.ts) → inserts token with 5-min TTL
 *   confirm-agent-run (here)             → validates + deletes token (one-use)
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => null) as { confirmation_token?: string } | null
  if (!body?.confirmation_token) {
    return NextResponse.json({ error: 'confirmation_token required' }, { status: 400 })
  }

  const token = body.confirmation_token

  // ── 1. Validate token ─────────────────────────────────────────────────────
  const { data: pending } = await db
    .from('mimir_pending_triggers')
    .select('token, owner_user_id, agent_key, expires_at')
    .eq('token', token)
    .single()

  if (!pending) {
    return NextResponse.json(
      { error: 'Invalid or expired confirmation. Ask Mimir to propose the run again.' },
      { status: 400 }
    )
  }

  if (pending.owner_user_id !== ownerId) {
    return NextResponse.json(
      { error: 'Invalid or expired confirmation. Ask Mimir to propose the run again.' },
      { status: 403 }
    )
  }

  if (new Date(pending.expires_at) < new Date()) {
    // Clean up expired token
    await db.from('mimir_pending_triggers').delete().eq('token', token)
    return NextResponse.json(
      { error: 'Confirmation expired (tokens are valid for 5 minutes). Ask Mimir to propose the run again.' },
      { status: 400 }
    )
  }

  const agentKey = pending.agent_key
  if (!VALID_AGENTS.has(agentKey)) {
    await db.from('mimir_pending_triggers').delete().eq('token', token)
    return NextResponse.json({ error: `Unknown agent: ${agentKey}` }, { status: 400 })
  }

  // ── 2. Delete token (one-time use) ────────────────────────────────────────
  await db.from('mimir_pending_triggers').delete().eq('token', token)

  // ── 3. Check agent isn't already running (defence-in-depth) ──────────────
  const { data: runningRow } = await db
    .from('agent_runs')
    .select('id, status, started_at')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', agentKey)
    .eq('status', 'running')
    .is('finished_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (runningRow) {
    return NextResponse.json(
      { error: `${agentKey} is already running (started ${new Date(runningRow.started_at).toLocaleTimeString()}). Wait for it to finish.` },
      { status: 409 }
    )
  }

  // ── 4. Fire the run via existing endpoint ─────────────────────────────────
  // We use a race between the actual run fetch and a 7-second timeout.
  // On Vercel Hobby plan the free-tier timeout is 10s per function invocation.
  // The agent run is its own separate serverless function invocation — it
  // continues running independently even after this function returns.
  // So: if the agent completes within 7s we return the full result; otherwise
  // we return "triggered" immediately and let the agent run in the background.
  // The user can check Command Center for the result.

  const origin = req.headers.get('origin') ?? process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const cookie = req.headers.get('cookie') ?? ''

  const runFetch = fetch(`${origin}/api/agents/${agentKey}/run`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie,
    },
    body: JSON.stringify({ site: 'g2g' }),
  })

  // Race: 7 s ceiling so this function returns well within Vercel's 10 s limit
  const TIMEOUT_MS = 7_000
  const timeoutSignal = new Promise<null>(resolve =>
    setTimeout(() => resolve(null), TIMEOUT_MS)
  )

  const winner = await Promise.race([runFetch, timeoutSignal])

  // ── Timed out — agent is still running in the background ─────────────────
  if (winner === null) {
    return NextResponse.json({
      ok:    true,
      agent: agentKey,
      note:  `${agentKey} is running in the background (takes 10–60s). Check the Command Center in a minute for results and queued actions.`,
    })
  }

  // ── Agent responded within 7 s ────────────────────────────────────────────
  const runRes  = winner as Response
  const runData = await runRes.json().catch(() => ({})) as {
    runId?: string
    summary?: string
    actionsQueued?: number
    error?: string
  }

  if (!runRes.ok) {
    return NextResponse.json(
      { error: runData.error ?? `Agent run failed (HTTP ${runRes.status})` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    ok:            true,
    agent:         agentKey,
    run_id:        runData.runId,
    summary:       runData.summary,
    actionsQueued: runData.actionsQueued ?? 0,
  })
}
