import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Get all agents for this owner
  const { data: agents, error: agentsErr } = await db
    .from('agents')
    .select('*')
    .eq('owner_user_id', effectiveOwnerId)

  if (agentsErr) {
    return NextResponse.json({ error: agentsErr.message }, { status: 500 })
  }

  // Get pending actions grouped by agent
  const { data: pendingActions, error: actionsErr } = await db
    .from('agent_actions')
    .select('agent_key')
    .eq('owner_user_id', effectiveOwnerId)
    .eq('status', 'pending')

  if (actionsErr) {
    return NextResponse.json({ error: actionsErr.message }, { status: 500 })
  }

  const actionsByAgent: Record<string, number> = {}
  let totalPending = 0

  for (const action of pendingActions || []) {
    actionsByAgent[action.agent_key] = (actionsByAgent[action.agent_key] ?? 0) + 1
    totalPending++
  }

  return NextResponse.json({
    agents: (agents || []).map(a => ({
      key: a.agent_key,
      isActive: a.is_active,
      lastRunAt: a.last_run_at,
      lastRunStatus: a.last_run_status,
      lastRunSummary: a.last_run_summary,
    })),
    pendingActions: totalPending,
    actionsByAgent,
  })
}
