import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runHeimdall, HEIMDALL_DEFAULTS, type HeimdallConfig } from '@/lib/agents/heimdall'
import { runOdin } from '@/lib/agents/odin'
import { runLoki } from '@/lib/agents/loki'
import { runBragi } from '@/lib/agents/bragi'
import { runHermod } from '@/lib/agents/hermod'
import { runTyr,   TYR_DEFAULTS,   type TyrConfig }   from '@/lib/agents/tyr'
import { runMimir, MIMIR_DEFAULTS, type MimirConfig } from '@/lib/agents/mimir'
import { notifyAgentRun, buildAgentNotification, type PendingAction } from '@/lib/slack/notify'

export const maxDuration = 300

function verifyAuth(request: Request) {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

function computeNextRun(config: Record<string, unknown>): Date {
  const frequency = (config.schedule_frequency as string) ?? 'daily'
  const day       = (config.schedule_day      as number)  ?? 1
  const hour      = (config.schedule_hour     as number)  ?? 9
  const tz        = (config.schedule_timezone as string)  ?? 'UTC'

  const now    = new Date()
  const tzNow  = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tz }))
  tzDate.setHours(hour, 0, 0, 0)

  if (frequency === 'weekly') {
    const currentDay = tzNow.getDay()
    let daysUntil = (day - currentDay + 7) % 7
    if (daysUntil === 0 && tzNow >= tzDate) daysUntil = 7
    tzDate.setDate(tzDate.getDate() + daysUntil)
  } else {
    if (tzNow >= tzDate) tzDate.setDate(tzDate.getDate() + 1)
  }

  const offsetMs = now.getTime() - tzNow.getTime()
  return new Date(tzDate.getTime() + offsetMs)
}

// GET /api/cron/agents-scheduler
// Runs every 15 minutes. Finds agents whose schedule_next_run_at is in the past
// and schedule_enabled = true, then runs them.
export async function GET(request: Request) {
  if (!verifyAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const now = new Date().toISOString()

  // Find all agent rows that are scheduled and overdue
  const { data: dueAgents, error } = await db
    .from('agents')
    .select('*')
    .lte('schedule_next_run_at', now)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!dueAgents?.length) {
    return NextResponse.json({ message: 'No agents due', checked: now })
  }

  // Filter to only schedule-enabled agents
  const toRun = dueAgents.filter(a => {
    const cfg = (a.config ?? {}) as Record<string, unknown>
    return cfg.schedule_enabled === true
  })

  if (!toRun.length) {
    return NextResponse.json({ message: 'No enabled agents due', checked: now })
  }

  const results: Record<string, unknown> = {}

  for (const agentRow of toRun) {
    const key     = agentRow.agent_key as string
    const ownerId = agentRow.owner_user_id as string
    const config  = (agentRow.config ?? {}) as Record<string, unknown>
    const siteSlug = 'g2g'

    try {
      // Create run record
      const { data: runRecord, error: runErr } = await db
        .from('agent_runs')
        .insert({
          owner_user_id: ownerId,
          agent_key:     key,
          site_slug:     siteSlug,
          status:        'running',
          started_at:    new Date().toISOString(),
        })
        .select('id')
        .single()

      if (runErr || !runRecord) {
        results[`${ownerId}/${key}`] = { status: 'error', error: 'Failed to create run record' }
        continue
      }

      const runId = runRecord.id
      let result: { summary: string; actionsQueued: number }

      if (key === 'heimdall') {
        const agentConfig: Partial<HeimdallConfig> = {
          maxDropsPerDay: typeof config.maxDropsPerDay === 'number' ? config.maxDropsPerDay : HEIMDALL_DEFAULTS.maxDropsPerDay,
          minClicksDrop:  typeof config.minClicksDrop  === 'number' ? config.minClicksDrop  : HEIMDALL_DEFAULTS.minClicksDrop,
          minPctDrop:     typeof config.minPctDrop     === 'number' ? config.minPctDrop     : HEIMDALL_DEFAULTS.minPctDrop,
        }
        result = await runHeimdall(ownerId, siteSlug, runId, agentConfig)
      } else if (key === 'odin') {
        result = await runOdin(ownerId, siteSlug, runId)
      } else if (key === 'loki') {
        result = await runLoki(ownerId, siteSlug, runId)
      } else if (key === 'bragi') {
        result = await runBragi(ownerId, siteSlug, runId)
      } else if (key === 'hermod') {
        result = await runHermod(ownerId, siteSlug, runId)
      } else if (key === 'tyr') {
        const tyrConfig: Partial<TyrConfig> = {
          minScore:         typeof config.minScore === 'number'         ? config.minScore         : TYR_DEFAULTS.minScore,
          borderlineWindow: typeof config.borderlineWindow === 'number' ? config.borderlineWindow : TYR_DEFAULTS.borderlineWindow,
          maxBriefsPerDay:  typeof config.maxBriefsPerDay === 'number'  ? config.maxBriefsPerDay  : TYR_DEFAULTS.maxBriefsPerDay,
          timezone:         typeof config.timezone === 'string'         ? config.timezone         : TYR_DEFAULTS.timezone,
        }
        result = await runTyr(ownerId, siteSlug, runId, tyrConfig)
      } else if (key === 'mimir') {
        const mimirConfig: Partial<MimirConfig> = {
          windowDays:           typeof config.windowDays === 'number'           ? config.windowDays           : MIMIR_DEFAULTS.windowDays,
          minSampleSize:        typeof config.minSampleSize === 'number'        ? config.minSampleSize        : MIMIR_DEFAULTS.minSampleSize,
          approvalRateThresh:   typeof config.approvalRateThresh === 'number'   ? config.approvalRateThresh   : MIMIR_DEFAULTS.approvalRateThresh,
          highConfidenceThresh: typeof config.highConfidenceThresh === 'number' ? config.highConfidenceThresh : MIMIR_DEFAULTS.highConfidenceThresh,
        }
        result = await runMimir(ownerId, siteSlug, runId, mimirConfig)
      } else {
        results[`${ownerId}/${key}`] = { status: 'skipped', reason: 'not implemented' }
        continue
      }

      // Update next_run_at for the agent
      const nextRun = computeNextRun(config)
      await db
        .from('agents')
        .update({ schedule_next_run_at: nextRun.toISOString() })
        .eq('owner_user_id', ownerId)
        .eq('agent_key', key)

      results[`${ownerId}/${key}`] = { status: 'ok', ...result }

      // Slack notification if actions were queued
      if (result.actionsQueued > 0) {
        const { data: pendingActions } = await db
          .from('agent_actions')
          .select('id, title, description, priority, action_type')
          .eq('owner_user_id', ownerId)
          .eq('agent_key', key)
          .eq('run_id', runId)
          .eq('status', 'pending')
          .order('priority', { ascending: false })
          .limit(5)

        const actions: PendingAction[] = (pendingActions ?? []).map((a: { id: string; title: string; description: string | null; priority: string; action_type: string }) => ({
          id:          a.id,
          title:       a.title,
          description: a.description,
          priority:    a.priority,
          actionType:  a.action_type,
        }))

        notifyAgentRun(buildAgentNotification(key, runId, result, actions))
          .catch((e: unknown) => console.error('[slack] notify failed:', e))
      }
    } catch (err) {
      results[`${ownerId}/${key}`] = { status: 'error', error: String(err) }
    }
  }

  return NextResponse.json({
    ran: Object.keys(results).length,
    results,
    checkedAt: now,
  })
}
