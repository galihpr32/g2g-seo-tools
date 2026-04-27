import { createServiceClient } from '@/lib/supabase/service'
import { persistFinding, type VorTuneRecommendationData } from '@/lib/agents/findings'

/**
 * Vor — Config Tuner (Norse goddess "the careful one — nothing can be hidden from her")
 *
 * Looks back over recent agent activity (default 30 days) and proposes
 * threshold adjustments to `agents.config` based on approval/rejection
 * patterns. Suggestions are queued as `tune_config` actions for the user
 * to approve. On approval, executor applies the new config and writes a
 * row to `agent_config_history`.
 *
 * NOTE: Renamed from "Mimir" to avoid name collision with the existing
 * "Mimir The All Knowing" interactive chatbot oracle (src/components/
 * dashboard/AIAssistant.tsx). They serve different purposes — the chatbot
 * answers questions on demand; this agent proactively tunes thresholds.
 *
 * What Vor tunes (initial heuristics — kept conservative):
 *
 * 1. HEIMDALL.minClicksDrop / minPctDrop
 *    - If reject_rate(low-priority drops) > 0.5 over ≥10 actions → suggest +20% threshold
 *    - If approve_rate(low-priority drops) > 0.85 → suggest -10% (we're missing things)
 *
 * 2. LOKI.lowPriorityVolumeCutoff (synthesised)
 *    - If >70% of low-volume gap actions get rejected → suggest raising
 *      the "low" volume cutoff from 1000 → 2000.
 *
 * 3. ODIN.skipLowPriority (synthesised)
 *    - Track approve/reject by computed totalScore band; suggest cutoff shift.
 *
 * 4. TYR.minScore
 *    - If >85% of auto-promoted briefs (score ≥ minScore) get manually
 *      published WITHOUT user editing notes → suggest LOWER minScore.
 *    - If >30% of auto-promoted briefs get manually demoted by the user
 *      back to 'draft' → suggest HIGHER minScore.
 *
 * Vor does NOT auto-apply. Every suggestion goes through the approval queue.
 */

export interface VorConfig {
  windowDays:           number   // default 30
  minSampleSize:        number   // default 10
  approvalRateThresh:   number   // default 0.5 — reject_rate > this → tighten
  highConfidenceThresh: number   // default 0.85 — approve_rate > this → loosen
}

export const VOR_DEFAULTS: VorConfig = {
  windowDays:           30,
  minSampleSize:        10,
  approvalRateThresh:   0.5,
  highConfidenceThresh: 0.85,
}

interface ActionRow {
  id:          string
  agent_key:   string
  action_type: string
  priority:    string | null
  status:      string
  data:        Record<string, unknown> | null
  created_at:  string
}

export async function runVor(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<VorConfig> = {}
): Promise<{ summary: string; actionsQueued: number }> {
  const cfg = { ...VOR_DEFAULTS, ...config }
  const db = createServiceClient()
  const warnings: string[] = []
  const suggestions: Array<{ agent_key: string; suggestion: TuneSuggestion }> = []

  try {
    const sinceIso = new Date(Date.now() - cfg.windowDays * 24 * 60 * 60 * 1000).toISOString()

    // 1. Pull every action from the window
    const { data: actions, error: actionsErr } = await db
      .from('agent_actions')
      .select('id, agent_key, action_type, priority, status, data, created_at')
      .eq('owner_user_id', ownerId)
      .gte('created_at', sinceIso)

    if (actionsErr) throw new Error(`agent_actions query failed: ${actionsErr.message}`)

    // 2. Get current config for each agent
    const { data: agentRows } = await db
      .from('agents')
      .select('agent_key, config')
      .eq('owner_user_id', ownerId)

    const configByAgent = new Map<string, Record<string, unknown>>()
    for (const a of agentRows ?? []) {
      configByAgent.set(a.agent_key as string, (a.config ?? {}) as Record<string, unknown>)
    }

    // 3. Per-agent analysis
    const heimdallSuggestion = analyseHeimdall(actions ?? [], configByAgent.get('heimdall') ?? {}, cfg)
    if (heimdallSuggestion) suggestions.push({ agent_key: 'heimdall', suggestion: heimdallSuggestion })

    const lokiSuggestion = analyseLoki(actions ?? [], configByAgent.get('loki') ?? {}, cfg)
    if (lokiSuggestion) suggestions.push({ agent_key: 'loki', suggestion: lokiSuggestion })

    const odinSuggestion = analyseOdin(actions ?? [], configByAgent.get('odin') ?? {}, cfg)
    if (odinSuggestion) suggestions.push({ agent_key: 'odin', suggestion: odinSuggestion })

    const tyrSuggestion = await analyseTyr(db, ownerId, sinceIso, configByAgent.get('tyr') ?? {}, cfg)
    if (tyrSuggestion) suggestions.push({ agent_key: 'tyr', suggestion: tyrSuggestion })

    // 4. Queue tune_config actions
    let actionsQueued = 0
    for (const { agent_key, suggestion } of suggestions) {
      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key:     'vor',
          run_id:        runId,
          site_slug:     siteSlug,
          action_type:   'tune_config',
          title:         `Tune ${capitalize(agent_key)} — ${suggestion.headline}`,
          description:   suggestion.description,
          priority:      'medium',
          data: {
            target_agent:     agent_key,
            current_config:   suggestion.currentConfig,
            suggested_config: suggestion.suggestedConfig,
            reasoning:        suggestion.reasoning,
            sample_size:      suggestion.sampleSize,
          },
        })

      if (insertErr) {
        console.error(`[vor] failed to queue tune_config for ${agent_key}:`, insertErr.message)
        warnings.push(`failed to queue suggestion for ${agent_key}`)
      } else {
        actionsQueued++
      }

      // Persist as agent_finding so /command-center/tuning can show the
      // full proposal feed (incl. ones that were approved/rejected and
      // are no longer in the active queue).
      // NOTE: each suggestion may target multiple parameters. Write one
      // finding per parameter delta so the page can render a clean per-
      // parameter row.
      const currentEntries = Object.entries(suggestion.currentConfig)
      for (const [param, currentVal] of currentEntries) {
        const suggestedVal = suggestion.suggestedConfig[param]
        if (suggestedVal === undefined || suggestedVal === currentVal) continue
        const recData: VorTuneRecommendationData = {
          target_agent:    agent_key,
          parameter:       param,
          current_value:   currentVal as number | string,
          suggested_value: suggestedVal as number | string,
          reasoning:       suggestion.reasoning,
          confidence:      Math.min(1, suggestion.sampleSize / 30),   // crude — sample-size based
          metric_basis:    `sample_size=${suggestion.sampleSize} over last ${cfg.windowDays}d`,
        }
        await persistFinding(db, {
          agentKey:    'vor',
          ownerId,
          runId,
          siteSlug,
          findingType: 'tune_recommendation',
          subject:     `${agent_key}.${param}`,
          severity:    'info',
          data:        { ...recData, headline: suggestion.headline } as unknown as Record<string, unknown>,
        })
      }
    }

    const summaryBase = suggestions.length
      ? `Generated ${actionsQueued} tuning suggestion${actionsQueued !== 1 ? 's' : ''} for: ${suggestions.map(s => capitalize(s.agent_key)).join(', ')}.`
      : `No tuning needed — current configs look balanced over last ${cfg.windowDays}d.`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase
    const status = warnings.length ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, summary, suggestions.length, actionsQueued, warnings)
    return { summary, actionsQueued }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', msg, 0, 0, warnings, msg)
    throw err
  }
}

// ── Per-agent analysers ─────────────────────────────────────────────────────

interface TuneSuggestion {
  headline:        string
  description:     string
  currentConfig:   Record<string, unknown>
  suggestedConfig: Record<string, unknown>
  reasoning:       string
  sampleSize:      number
}

function analyseHeimdall(
  allActions: ActionRow[],
  currentConfig: Record<string, unknown>,
  cfg: VorConfig,
): TuneSuggestion | null {
  const heimActions = allActions.filter(a => a.agent_key === 'heimdall' && a.action_type === 'add_action_item')
  if (heimActions.length < cfg.minSampleSize) return null

  const lowPri = heimActions.filter(a => a.priority === 'medium')
  const lowResolved = lowPri.filter(a => ['approved', 'executed', 'rejected'].includes(a.status))
  if (lowResolved.length < cfg.minSampleSize) return null

  const rejectRate = lowResolved.filter(a => a.status === 'rejected').length / lowResolved.length

  const minClicksDrop = Number(currentConfig.minClicksDrop ?? 5)
  const minPctDrop    = Number(currentConfig.minPctDrop ?? 20)

  if (rejectRate > cfg.approvalRateThresh) {
    const newClicks = Math.round(minClicksDrop * 1.4)
    const newPct    = Math.round(minPctDrop * 1.2)
    return {
      headline:    `Reduce noise: ${(rejectRate * 100).toFixed(0)}% of medium drops rejected`,
      description: `Over the last ${cfg.windowDays} days, you rejected ${(rejectRate * 100).toFixed(0)}% of Heimdall's medium-priority drop alerts (${lowResolved.length} samples). Suggest tightening thresholds so only worse drops get queued.`,
      currentConfig:   { minClicksDrop, minPctDrop },
      suggestedConfig: { minClicksDrop: newClicks, minPctDrop: newPct },
      reasoning:       `High rejection rate suggests current thresholds (${minClicksDrop} clicks / ${minPctDrop}%) are too lenient. Raising to ${newClicks} clicks / ${newPct}% should cut noise without losing significant drops.`,
      sampleSize:      lowResolved.length,
    }
  }

  if (rejectRate < (1 - cfg.highConfidenceThresh) && minClicksDrop > 3) {
    const newClicks = Math.max(3, Math.round(minClicksDrop * 0.8))
    const newPct    = Math.max(10, Math.round(minPctDrop * 0.9))
    return {
      headline:    `Lower threshold: ${((1 - rejectRate) * 100).toFixed(0)}% of medium drops approved`,
      description: `Over the last ${cfg.windowDays} days, ${((1 - rejectRate) * 100).toFixed(0)}% of medium-priority drops were approved (${lowResolved.length} samples). You may be missing smaller drops.`,
      currentConfig:   { minClicksDrop, minPctDrop },
      suggestedConfig: { minClicksDrop: newClicks, minPctDrop: newPct },
      reasoning:       `Very high approval rate suggests Heimdall is being conservative. Lowering to ${newClicks} clicks / ${newPct}% surfaces additional candidates.`,
      sampleSize:      lowResolved.length,
    }
  }

  return null
}

function analyseLoki(
  allActions: ActionRow[],
  currentConfig: Record<string, unknown>,
  cfg: VorConfig,
): TuneSuggestion | null {
  const lokiGaps = allActions.filter(a => a.agent_key === 'loki' && a.action_type === 'add_action_item' && (a.data?.action_type === 'on_page' || a.data?.action_type === 'new_page'))
  if (lokiGaps.length < cfg.minSampleSize) return null

  const lowVol = lokiGaps.filter(a => Number(a.data?.search_volume ?? 0) < 1000 && ['approved', 'rejected', 'executed'].includes(a.status))
  if (lowVol.length < cfg.minSampleSize) return null

  const rejectRate = lowVol.filter(a => a.status === 'rejected').length / lowVol.length

  if (rejectRate > 0.7) {
    const currentLowCutoff = Number(currentConfig.lowPriorityVolumeCutoff ?? 1000)
    return {
      headline:    `Skip low-volume gaps: ${(rejectRate * 100).toFixed(0)}% rejection rate`,
      description: `${(rejectRate * 100).toFixed(0)}% of gaps under ${currentLowCutoff.toLocaleString()} monthly searches were rejected (${lowVol.length} samples). Suggest skipping these entirely.`,
      currentConfig:   { lowPriorityVolumeCutoff: currentLowCutoff },
      suggestedConfig: { lowPriorityVolumeCutoff: currentLowCutoff * 2 },
      reasoning:       `Loki currently queues gaps with any volume. Raising the cutoff to ${(currentLowCutoff * 2).toLocaleString()} skips low-yield gaps that consistently get rejected.`,
      sampleSize:      lowVol.length,
    }
  }
  return null
}

function analyseOdin(
  allActions: ActionRow[],
  currentConfig: Record<string, unknown>,
  cfg: VorConfig,
): TuneSuggestion | null {
  const odinTrends = allActions.filter(a => a.agent_key === 'odin' && a.action_type === 'suggest_trend_brief')
  if (odinTrends.length < cfg.minSampleSize) return null

  const lowPri = odinTrends.filter(a => a.priority === 'low' && ['approved', 'rejected', 'executed'].includes(a.status))
  if (lowPri.length < cfg.minSampleSize) return null

  const rejectRate = lowPri.filter(a => a.status === 'rejected').length / lowPri.length

  if (rejectRate > 0.7) {
    const currentSkipLow = Boolean(currentConfig.skipLowPriority ?? false)
    if (!currentSkipLow) {
      return {
        headline:    `Skip low-priority trends: ${(rejectRate * 100).toFixed(0)}% rejected`,
        description: `${(rejectRate * 100).toFixed(0)}% of low-priority trend suggestions were rejected (${lowPri.length} samples). Suggest filtering them out at source.`,
        currentConfig:   { skipLowPriority: false },
        suggestedConfig: { skipLowPriority: true },
        reasoning:       `When skipLowPriority is true, Odin won't even queue trends scored as 'low'. Reduces noise.`,
        sampleSize:      lowPri.length,
      }
    }
  }
  return null
}

async function analyseTyr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
  sinceIso: string,
  currentConfig: Record<string, unknown>,
  cfg: VorConfig,
): Promise<TuneSuggestion | null> {
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, status, tyr_score, tyr_status, tyr_reviewed_at')
    .eq('owner_user_id', ownerId)
    .gte('tyr_reviewed_at', sinceIso)
    .not('tyr_score', 'is', null)

  const reviewed: Array<{ status: string; tyr_score: number; tyr_status: string }> = (briefs ?? []) as Array<{ status: string; tyr_score: number; tyr_status: string }>
  if (reviewed.length < cfg.minSampleSize) return null

  const minScore = Number(currentConfig.minScore ?? 80)
  const autoPromoted = reviewed.filter(b => b.tyr_status === 'reviewed')
  if (autoPromoted.length < cfg.minSampleSize) return null

  const demotedRate   = autoPromoted.filter(b => b.status === 'draft').length     / autoPromoted.length
  const publishedRate = autoPromoted.filter(b => b.status === 'published').length / autoPromoted.length

  if (demotedRate > 0.3) {
    const newMin = Math.min(95, minScore + 5)
    return {
      headline:    `Tighten Tyr: ${(demotedRate * 100).toFixed(0)}% of auto-promoted briefs got demoted`,
      description: `${(demotedRate * 100).toFixed(0)}% of briefs Tyr auto-promoted (≥${minScore}) ended up demoted back to 'draft' by you. Tyr is being too lenient.`,
      currentConfig:   { minScore },
      suggestedConfig: { minScore: newMin },
      reasoning:       `Raising minScore to ${newMin} should reduce false-positives — fewer briefs auto-promoted, but those that pass should be higher quality.`,
      sampleSize:      autoPromoted.length,
    }
  }

  if (publishedRate > cfg.highConfidenceThresh && minScore > 70) {
    const newMin = Math.max(70, minScore - 5)
    return {
      headline:    `Loosen Tyr: ${(publishedRate * 100).toFixed(0)}% of auto-promoted briefs got published`,
      description: `${(publishedRate * 100).toFixed(0)}% of Tyr's auto-promoted briefs went straight to publish without edits. Tyr could be more permissive.`,
      currentConfig:   { minScore },
      suggestedConfig: { minScore: newMin },
      reasoning:       `Very high publish-without-edit rate suggests Tyr is overly strict. Lowering to ${newMin} surfaces more candidates while maintaining quality.`,
      sampleSize:      autoPromoted.length,
    }
  }

  return null
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId: string,
  ownerId: string,
  status: 'success' | 'error' | 'partial',
  summary: string,
  findingsCount: number,
  actionsQueued: number,
  warnings: string[],
  errorMessage?: string
) {
  await db
    .from('agent_runs')
    .update({
      status,
      summary,
      findings_count: findingsCount,
      actions_queued: actionsQueued,
      error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
      finished_at:    new Date().toISOString(),
    })
    .eq('id', runId)

  await db
    .from('agents')
    .update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  status,
      last_run_summary: summary,
    })
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'vor')
}
