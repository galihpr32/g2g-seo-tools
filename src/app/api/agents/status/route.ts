import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug         = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  // Get all agents for this owner.
  // Note: `agents` table itself isn't site-scoped — agent definitions are
  // shared across brands. Per-brand stats live on agent_runs/agent_actions.
  const { data: agents, error: agentsErr } = await db
    .from('agents')
    .select('*')
    .eq('owner_user_id', effectiveOwnerId)

  if (agentsErr) {
    return NextResponse.json({ error: agentsErr.message }, { status: 500 })
  }

  // Get pending actions grouped by agent (site-scoped).
  const { data: pendingActions, error: actionsErr } = await db
    .from('agent_actions')
    .select('agent_key')
    .eq('owner_user_id', effectiveOwnerId)
    .eq('site_slug', siteSlug)
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
    agents: (agents || []).map(a => {
      const cfg = (a.config ?? {}) as Record<string, unknown>
      return {
        key: a.agent_key,
        isActive: a.is_active,
        lastRunAt: a.last_run_at,
        lastRunStatus: a.last_run_status,
        lastRunSummary: a.last_run_summary,
        schedule: {
          enabled:   (cfg.schedule_enabled   as boolean)          ?? false,
          frequency: (cfg.schedule_frequency as 'daily'|'weekly') ?? 'daily',
          day:       (cfg.schedule_day       as number)           ?? 1,
          hour:      (cfg.schedule_hour      as number)           ?? 9,
          timezone:  (cfg.schedule_timezone  as string)           ?? 'Asia/Jakarta',
        },
        nextRunAt: (a as Record<string, unknown>).schedule_next_run_at ?? null,
      }
    }),
    pendingActions: totalPending,
    actionsByAgent,
  })
}
