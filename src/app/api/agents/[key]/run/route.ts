import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runHeimdall, HEIMDALL_DEFAULTS, type HeimdallConfig } from '@/lib/agents/heimdall'
import { runOdin } from '@/lib/agents/odin'
import { runLoki } from '@/lib/agents/loki'
import { runBragi } from '@/lib/agents/bragi'
import { runHermod } from '@/lib/agents/hermod'
import { notifyAgentRun, buildAgentNotification, type PendingAction } from '@/lib/slack/notify'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { key } = await params
  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await request.json()
  const siteSlug = body.site ?? 'g2g'

  try {
    // Fetch agent config from DB (if exists)
    const { data: agentRow } = await db
      .from('agents')
      .select('config')
      .eq('owner_user_id', effectiveOwnerId)
      .eq('agent_key', key)
      .maybeSingle()

    const savedConfig = (agentRow?.config ?? {}) as Record<string, unknown>

    // Create run record
    const { data: runRecord, error: runErr } = await db
      .from('agent_runs')
      .insert({
        owner_user_id: effectiveOwnerId,
        agent_key: key,
        site_slug: siteSlug,
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (runErr || !runRecord) {
      return NextResponse.json({ error: 'Failed to create run record' }, { status: 500 })
    }

    const runId = runRecord.id

    // Dispatch agent based on key
    let result: { summary: string; actionsQueued: number }

    if (key === 'heimdall') {
      const config: Partial<HeimdallConfig> = {
        maxDropsPerDay: typeof savedConfig.maxDropsPerDay === 'number'
          ? savedConfig.maxDropsPerDay
          : HEIMDALL_DEFAULTS.maxDropsPerDay,
        minClicksDrop: typeof savedConfig.minClicksDrop === 'number'
          ? savedConfig.minClicksDrop
          : HEIMDALL_DEFAULTS.minClicksDrop,
        minPctDrop: typeof savedConfig.minPctDrop === 'number'
          ? savedConfig.minPctDrop
          : HEIMDALL_DEFAULTS.minPctDrop,
      }
      result = await runHeimdall(effectiveOwnerId, siteSlug, runId, config)
    } else if (key === 'odin') {
      result = await runOdin(effectiveOwnerId, siteSlug, runId)
    } else if (key === 'loki') {
      result = await runLoki(effectiveOwnerId, siteSlug, runId)
    } else if (key === 'bragi') {
      result = await runBragi(effectiveOwnerId, siteSlug, runId)
    } else if (key === 'hermod') {
      result = await runHermod(effectiveOwnerId, siteSlug, runId)
    } else {
      return NextResponse.json(
        { error: `Agent not yet implemented: ${key}` },
        { status: 400 }
      )
    }

    // Fire-and-forget Slack notification (only if actions were queued)
    if (result.actionsQueued > 0) {
      const { data: pendingActions } = await db
        .from('agent_actions')
        .select('id, title, description, priority, action_type')
        .eq('owner_user_id', effectiveOwnerId)
        .eq('agent_key', key)
        .eq('run_id', runId)
        .eq('status', 'pending')
        .order('priority', { ascending: false })
        .limit(5)

      const actions: PendingAction[] = (pendingActions ?? []).map(a => ({
        id:          a.id,
        title:       a.title,
        description: a.description,
        priority:    a.priority,
        actionType:  a.action_type,
      }))

      notifyAgentRun(buildAgentNotification(key, runId, result, actions))
        .catch(err => console.error('[slack] notify failed:', err))
    }

    return NextResponse.json({
      runId,
      ...result,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
