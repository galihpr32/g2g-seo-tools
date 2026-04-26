import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runHeimdall, HEIMDALL_DEFAULTS, type HeimdallConfig } from '@/lib/agents/heimdall'
import { runOdin } from '@/lib/agents/odin'
import { runLoki } from '@/lib/agents/loki'
import { runBragi } from '@/lib/agents/bragi'
import { runHermod } from '@/lib/agents/hermod'
import { runTyr,   TYR_DEFAULTS,   type TyrConfig }   from '@/lib/agents/tyr'
import { runMimir, MIMIR_DEFAULTS, type MimirConfig } from '@/lib/agents/mimir'
import { runSaga,  SAGA_DEFAULTS,  type SagaConfig }  from '@/lib/agents/saga'
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

  // Track runId in outer scope so the outer catch can mark the run as failed
  // even if the agent throws *before* entering its own try-block (e.g. import
  // error, createServiceClient failure). Previously such errors left the
  // agent_runs row stuck in 'running' status forever.
  let runId: string | null = null

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

    const dispatchRunId: string = runRecord.id
    runId = dispatchRunId

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
      result = await runHeimdall(effectiveOwnerId, siteSlug, dispatchRunId, config)
    } else if (key === 'odin') {
      result = await runOdin(effectiveOwnerId, siteSlug, dispatchRunId)
    } else if (key === 'loki') {
      result = await runLoki(effectiveOwnerId, siteSlug, dispatchRunId)
    } else if (key === 'bragi') {
      result = await runBragi(effectiveOwnerId, siteSlug, dispatchRunId)
    } else if (key === 'hermod') {
      result = await runHermod(effectiveOwnerId, siteSlug, dispatchRunId)
    } else if (key === 'tyr') {
      const tyrConfig: Partial<TyrConfig> = {
        minScore:         typeof savedConfig.minScore === 'number'         ? savedConfig.minScore         : TYR_DEFAULTS.minScore,
        borderlineWindow: typeof savedConfig.borderlineWindow === 'number' ? savedConfig.borderlineWindow : TYR_DEFAULTS.borderlineWindow,
        maxBriefsPerDay:  typeof savedConfig.maxBriefsPerDay === 'number'  ? savedConfig.maxBriefsPerDay  : TYR_DEFAULTS.maxBriefsPerDay,
        timezone:         typeof savedConfig.timezone === 'string'         ? savedConfig.timezone         : TYR_DEFAULTS.timezone,
      }
      result = await runTyr(effectiveOwnerId, siteSlug, dispatchRunId, tyrConfig)
    } else if (key === 'mimir') {
      const mimirConfig: Partial<MimirConfig> = {
        windowDays:           typeof savedConfig.windowDays === 'number'           ? savedConfig.windowDays           : MIMIR_DEFAULTS.windowDays,
        minSampleSize:        typeof savedConfig.minSampleSize === 'number'        ? savedConfig.minSampleSize        : MIMIR_DEFAULTS.minSampleSize,
        approvalRateThresh:   typeof savedConfig.approvalRateThresh === 'number'   ? savedConfig.approvalRateThresh   : MIMIR_DEFAULTS.approvalRateThresh,
        highConfidenceThresh: typeof savedConfig.highConfidenceThresh === 'number' ? savedConfig.highConfidenceThresh : MIMIR_DEFAULTS.highConfidenceThresh,
      }
      result = await runMimir(effectiveOwnerId, siteSlug, dispatchRunId, mimirConfig)
    } else if (key === 'saga') {
      const sagaConfig: Partial<SagaConfig> = {
        windowDays:           typeof savedConfig.windowDays === 'number'           ? savedConfig.windowDays           : SAGA_DEFAULTS.windowDays,
        minKeywordsForTopic:  typeof savedConfig.minKeywordsForTopic === 'number'  ? savedConfig.minKeywordsForTopic  : SAGA_DEFAULTS.minKeywordsForTopic,
        archiveAgeDays:       typeof savedConfig.archiveAgeDays === 'number'       ? savedConfig.archiveAgeDays       : SAGA_DEFAULTS.archiveAgeDays,
        maxProposalsPerRun:   typeof savedConfig.maxProposalsPerRun === 'number'   ? savedConfig.maxProposalsPerRun   : SAGA_DEFAULTS.maxProposalsPerRun,
        coverageThresholdPct: typeof savedConfig.coverageThresholdPct === 'number' ? savedConfig.coverageThresholdPct : SAGA_DEFAULTS.coverageThresholdPct,
      }
      result = await runSaga(effectiveOwnerId, siteSlug, dispatchRunId, sagaConfig)
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
        .eq('run_id', dispatchRunId)
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

      notifyAgentRun(buildAgentNotification(key, dispatchRunId, result, actions))
        .catch(err => console.error('[slack] notify failed:', err))
    }

    return NextResponse.json({
      runId: dispatchRunId,
      ...result,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    // If the agent threw *before* it could finalise its own run record
    // (e.g. import-time error, DB connection failure), the row would stay
    // stuck in 'running'. Heal it here.
    if (runId) {
      try {
        await db
          .from('agent_runs')
          .update({
            status:        'error',
            error_message: errorMessage,
            finished_at:   new Date().toISOString(),
          })
          .eq('id', runId)
          .eq('status', 'running')   // only overwrite if agent didn't already finalise
        await db
          .from('agents')
          .update({
            last_run_at:      new Date().toISOString(),
            last_run_status:  'error',
            last_run_summary: errorMessage,
          })
          .eq('owner_user_id', effectiveOwnerId)
          .eq('agent_key', key)
      } catch (healErr) {
        console.error('[agents/run] failed to heal run record:', healErr)
      }
    }

    return NextResponse.json({ error: errorMessage, runId }, { status: 500 })
  }
}
