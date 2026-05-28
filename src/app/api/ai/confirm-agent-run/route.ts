import { NextResponse } from 'next/server'
import { after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 10

/**
 * POST /api/ai/confirm-agent-run
 *
 * Called by the ConfirmCard UI when the user clicks "Yes, run it".
 * Validates a one-time token from mimir_pending_triggers, then fires
 * the agent run in the background via /api/agents/[key]/run.
 *
 * Body: { confirmation_token: string }
 * Returns: { ok: true, agent: string, note: string }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  let token: string
  try {
    const body = await req.json()
    // Frontend sends { confirmation_token } — accept both field names for safety
    token = body?.confirmation_token ?? body?.token
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  // Look up the pending trigger
  const { data: trigger, error: lookupErr } = await supabase
    .from('mimir_pending_triggers')
    .select('token, agent_key, owner_user_id, expires_at')
    .eq('token', token)
    .maybeSingle()

  if (lookupErr) {
    console.error('[confirm-agent-run] DB lookup error:', lookupErr)
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }

  if (!trigger) {
    // BDT feedback (May 2026): this error was confusing — "Token not found"
    // sounded like an auth bug. Most common real cause is that the user
    // clicked confirm twice (one-time-use token), or hit refresh and the
    // token from the previous Mimir reply has been consumed.
    return NextResponse.json({
      error:  'This action was already triggered or the confirmation has expired (5-min window). Ask Mimir to run the agent again to get a fresh confirmation button.',
      hint:   'Most common cause: confirm clicked twice, or the Mimir reply is older than 5 minutes.',
      action: 'reopen_mimir',
    }, { status: 404 })
  }

  // Check expiry
  if (new Date(trigger.expires_at) < new Date()) {
    // Clean up expired token
    await supabase.from('mimir_pending_triggers').delete().eq('token', token)
    return NextResponse.json({
      error:  'Confirmation token expired (5-min window). Ask Mimir again to retry — the next confirmation button will work.',
      action: 'reopen_mimir',
    }, { status: 410 })
  }

  // Check ownership
  if (trigger.owner_user_id !== ownerId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const agentKey = trigger.agent_key

  // Delete token (one-time use) before firing the agent
  await supabase.from('mimir_pending_triggers').delete().eq('token', token)

  // Fire agent run in background — forward user's cookie for auth
  const vercelUrl = process.env.VERCEL_URL
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  const baseUrl = appUrl ?? (vercelUrl ? `https://${vercelUrl}` : 'http://localhost:3000')

  const cookie = req.headers.get('cookie') ?? ''
  // Forward whichever site the user is currently on (cookie/query/body) so
  // an OG user firing an agent via Mimir doesn't accidentally trigger G2G.
  const siteSlug = resolveSiteSlugFromRequest(req)

  after(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/agents/${agentKey}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        body: JSON.stringify({ site: siteSlug }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error(`[confirm-agent-run] Agent run failed (${res.status}):`, text)
      } else {
        console.log(`[confirm-agent-run] Agent ${agentKey} started successfully`)
      }
    } catch (err) {
      console.error('[confirm-agent-run] Failed to fire agent run:', err)
    }
  })

  return NextResponse.json({
    ok: true,
    agent: agentKey,
    note: `${agentKey} is starting in the background. Check the Agents page for progress.`,
  })
}
