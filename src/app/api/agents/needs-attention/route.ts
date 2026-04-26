import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET /api/agents/needs-attention
 *
 * Returns recent runs that completed but with degraded data ('partial')
 * OR outright failed ('error') in the last N days. Used by the
 * NeedsAttentionWidget on the Command Center to surface "succeed-but-shallow"
 * runs that previous versions silently swallowed as 'success / 0 actions'.
 *
 * Query params:
 *   ?days=7   (default 7, max 30)
 *   ?limit=20 (default 20, max 50)
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days  = Math.min(parseInt(searchParams.get('days')  ?? '7'), 30)
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20'), 50)

  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data: runs, error } = await db
    .from('agent_runs')
    .select('id, agent_key, status, summary, findings_count, actions_queued, error_message, started_at, finished_at')
    .eq('owner_user_id', ownerId)
    .in('status', ['partial', 'error'])
    .gte('started_at', sinceIso)
    .order('started_at', { ascending: false })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const items = (runs ?? []).map(r => ({
    runId:         r.id,
    agentKey:      r.agent_key,
    status:        r.status,
    summary:       r.summary,
    errorMessage:  r.error_message,
    findingsCount: r.findings_count,
    actionsQueued: r.actions_queued,
    startedAt:     r.started_at,
    finishedAt:    r.finished_at,
    durationMs:    r.finished_at && r.started_at
      ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
      : null,
    // Split error_message on '; ' since agents join warnings that way
    warnings:      typeof r.error_message === 'string'
      ? r.error_message.split('; ').filter(Boolean)
      : [],
  }))

  // Group by agent_key for the widget header counts
  const byAgent: Record<string, { partial: number; error: number }> = {}
  for (const it of items) {
    const slot = byAgent[it.agentKey] ?? (byAgent[it.agentKey] = { partial: 0, error: 0 })
    if (it.status === 'partial') slot.partial++
    else if (it.status === 'error') slot.error++
  }

  return NextResponse.json({
    items,
    byAgent,
    windowDays: days,
    total:      items.length,
  })
}
