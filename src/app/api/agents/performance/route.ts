import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

// GET /api/agents/performance
// Returns per-agent stats for the last N days
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days = Math.min(parseInt(searchParams.get('days') ?? '30'), 90)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const AGENTS = ['heimdall', 'odin', 'loki', 'bragi', 'hermod']

  // ── Agent runs in period ──────────────────────────────────────────────────
  const { data: runs } = await db
    .from('agent_runs')
    .select('agent_key, status, findings_count, actions_queued, started_at, finished_at, error_message')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('started_at', since)
    .order('started_at', { ascending: true })

  // ── Agent actions in period ───────────────────────────────────────────────
  const { data: actions } = await db
    .from('agent_actions')
    .select('agent_key, status, priority, created_at, approved_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('created_at', since)

  // ── Build per-agent stats ─────────────────────────────────────────────────
  interface AgentStats {
    key:            string
    totalRuns:      number
    successRuns:    number
    errorRuns:      number
    successRate:    number
    totalFindings:  number
    totalQueued:    number
    totalApproved:  number
    totalRejected:  number
    totalPending:   number
    approvalRate:   number
    avgRunMs:       number | null
    lastRunAt:      string | null
    runsByDay:      { date: string; runs: number; findings: number }[]
    actionsByDay:   { date: string; queued: number; approved: number }[]
  }

  const stats: Record<string, AgentStats> = {}

  for (const key of AGENTS) {
    const agentRuns    = (runs ?? []).filter(r => r.agent_key === key)
    const agentActions = (actions ?? []).filter(a => a.agent_key === key)

    const successRuns  = agentRuns.filter(r => r.status === 'success')
    const errorRuns    = agentRuns.filter(r => r.status === 'error')
    const approved     = agentActions.filter(a => a.status === 'approved' || a.status === 'executed')
    const rejected     = agentActions.filter(a => a.status === 'rejected')
    const pending      = agentActions.filter(a => a.status === 'pending')

    // Avg run duration
    const durationsMs = agentRuns
      .filter(r => r.started_at && r.finished_at)
      .map(r => new Date(r.finished_at!).getTime() - new Date(r.started_at).getTime())
    const avgRunMs = durationsMs.length > 0
      ? Math.round(durationsMs.reduce((s, d) => s + d, 0) / durationsMs.length)
      : null

    // Runs by day (last 30 days)
    const runsByDayMap = new Map<string, { runs: number; findings: number }>()
    for (const r of agentRuns) {
      const day = r.started_at.slice(0, 10)
      const cur = runsByDayMap.get(day) ?? { runs: 0, findings: 0 }
      runsByDayMap.set(day, { runs: cur.runs + 1, findings: cur.findings + (r.findings_count ?? 0) })
    }

    // Actions by day
    const actionsByDayMap = new Map<string, { queued: number; approved: number }>()
    for (const a of agentActions) {
      const day = a.created_at.slice(0, 10)
      const cur = actionsByDayMap.get(day) ?? { queued: 0, approved: 0 }
      const isApproved = a.status === 'approved' || a.status === 'executed'
      actionsByDayMap.set(day, { queued: cur.queued + 1, approved: cur.approved + (isApproved ? 1 : 0) })
    }

    stats[key] = {
      key,
      totalRuns:     agentRuns.length,
      successRuns:   successRuns.length,
      errorRuns:     errorRuns.length,
      successRate:   agentRuns.length > 0 ? Math.round((successRuns.length / agentRuns.length) * 100) : 0,
      totalFindings: agentRuns.reduce((s, r) => s + (r.findings_count ?? 0), 0),
      totalQueued:   agentRuns.reduce((s, r) => s + (r.actions_queued ?? 0), 0),
      totalApproved: approved.length,
      totalRejected: rejected.length,
      totalPending:  pending.length,
      approvalRate:  (approved.length + rejected.length) > 0
        ? Math.round((approved.length / (approved.length + rejected.length)) * 100)
        : 0,
      avgRunMs,
      lastRunAt:     agentRuns.at(-1)?.started_at ?? null,
      runsByDay:     [...runsByDayMap.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
      actionsByDay:  [...actionsByDayMap.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    }
  }

  // ── Overall totals ────────────────────────────────────────────────────────
  const overall = {
    totalRuns:     (runs ?? []).length,
    totalFindings: (runs ?? []).reduce((s, r) => s + (r.findings_count ?? 0), 0),
    totalQueued:   (runs ?? []).reduce((s, r) => s + (r.actions_queued ?? 0), 0),
    totalApproved: (actions ?? []).filter(a => a.status === 'approved' || a.status === 'executed').length,
    totalPending:  (actions ?? []).filter(a => a.status === 'pending').length,
  }

  return NextResponse.json({ stats, overall, days })
}
