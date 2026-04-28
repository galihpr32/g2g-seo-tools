import { createServiceClient } from '@/lib/supabase/service'
import { persistFinding } from '@/lib/agents/findings'

/**
 * Vor — Daily Stats Reporter
 * (Norse goddess "the careful one — nothing can be hidden from her")
 *
 * Vor runs once a day and takes a full snapshot of the pipeline's health:
 *
 *   1. Brief pipeline counts  (draft → generating → agent_generated → reviewed → published)
 *   2. Opportunity funnel     (new → triaged → brief_queued → brief_ready → dismissed)
 *   3. Agent run activity     (last 24h: success/error counts per agent)
 *   4. Action queue health    (pending / approved / rejected today)
 *   5. Tyr quality metrics    (avg score, pass/borderline/fail counts for the week)
 *   6. GSC snapshot           (total clicks + impressions from the most recent daily row)
 *
 * Results are written as a `daily_snapshot` agent_finding so the
 * Command Center → Performance page can chart them over time.
 *
 * Config tuning (old Vor behaviour) still runs as a secondary step when
 * enough sample data exists — suggestions surface in the approval queue.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VorConfig {
  windowDays:           number   // daily snapshot lookback: default 1 (yesterday)
  configWindowDays:     number   // config tuning lookback: default 30
  minSampleSize:        number   // default 10
  approvalRateThresh:   number   // reject_rate > this → tighten
  highConfidenceThresh: number   // approve_rate > this → loosen
  runConfigTuning:      boolean  // default true — set false to skip threshold suggestions
}

export const VOR_DEFAULTS: VorConfig = {
  windowDays:           1,
  configWindowDays:     30,
  minSampleSize:        10,
  approvalRateThresh:   0.5,
  highConfidenceThresh: 0.85,
  runConfigTuning:      true,
}

export interface DailySnapshot {
  date:             string
  brief_pipeline:   BriefPipelineStats
  opportunities:    OpportunityStats
  agent_activity:   AgentActivityStats
  action_queue:     ActionQueueStats
  tyr_metrics:      TyrMetrics
  gsc:              GscStats | null
}

interface BriefPipelineStats {
  draft:           number
  generating:      number
  agent_generated: number
  reviewed:        number
  published:       number
  total:           number
  published_today: number
}

interface OpportunityStats {
  new:          number
  triaged:      number
  brief_queued: number
  brief_ready:  number
  dismissed:    number
  total:        number
}

interface AgentActivityStats {
  runs_24h:   number
  success_24h: number
  error_24h:  number
  by_agent:   Record<string, { runs: number; success: number; error: number }>
}

interface ActionQueueStats {
  pending:  number
  approved_today: number
  rejected_today: number
  executed_today: number
}

interface TyrMetrics {
  avg_score:      number | null
  reviewed_week:  number
  passed:         number
  borderline:     number
  failed:         number
}

interface GscStats {
  total_clicks:      number
  total_impressions: number
  snapshot_date:     string
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

// ── Daily snapshot ────────────────────────────────────────────────────────────

async function captureDailySnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
): Promise<DailySnapshot> {
  const today     = new Date().toISOString().slice(0, 10)
  const since24h  = new Date(Date.now() -  1 * 24 * 60 * 60 * 1000).toISOString()
  const since7d   = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString()

  // ── 1. Brief pipeline ───────────────────────────────────────────────────────
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('status, updated_at')
    .eq('owner_user_id', ownerId)

  const bstats: BriefPipelineStats = { draft: 0, generating: 0, agent_generated: 0, reviewed: 0, published: 0, total: 0, published_today: 0 }
  for (const b of briefs ?? []) {
    bstats.total++
    const s = String(b.status ?? 'draft')
    if (s === 'draft')           bstats.draft++
    else if (s === 'generating') bstats.generating++
    else if (s === 'agent_generated') bstats.agent_generated++
    else if (s === 'reviewed')   bstats.reviewed++
    else if (s === 'published') {
      bstats.published++
      // Published today
      if (b.updated_at && String(b.updated_at).slice(0, 10) === today) bstats.published_today++
    }
  }

  // ── 2. Opportunities ────────────────────────────────────────────────────────
  const { data: opps } = await db
    .from('seo_opportunities')
    .select('status')
    .eq('owner_user_id', ownerId)

  const ostats: OpportunityStats = { new: 0, triaged: 0, brief_queued: 0, brief_ready: 0, dismissed: 0, total: 0 }
  for (const o of opps ?? []) {
    ostats.total++
    const s = String(o.status ?? 'new')
    if      (s === 'new')          ostats.new++
    else if (s === 'triaged')      ostats.triaged++
    else if (s === 'brief_queued') ostats.brief_queued++
    else if (s === 'brief_ready')  ostats.brief_ready++
    else if (s === 'dismissed')    ostats.dismissed++
  }

  // ── 3. Agent activity (last 24h) ────────────────────────────────────────────
  const { data: runs } = await db
    .from('agent_runs')
    .select('agent_key, status, started_at')
    .eq('owner_user_id', ownerId)
    .gte('started_at', since24h)

  const astats: AgentActivityStats = { runs_24h: 0, success_24h: 0, error_24h: 0, by_agent: {} }
  for (const r of runs ?? []) {
    astats.runs_24h++
    const key = String(r.agent_key ?? 'unknown')
    if (!astats.by_agent[key]) astats.by_agent[key] = { runs: 0, success: 0, error: 0 }
    astats.by_agent[key].runs++
    if (r.status === 'success') { astats.success_24h++; astats.by_agent[key].success++ }
    else if (r.status === 'error') { astats.error_24h++;   astats.by_agent[key].error++ }
  }

  // ── 4. Action queue (today) ─────────────────────────────────────────────────
  const { data: allActions } = await db
    .from('agent_actions')
    .select('status, updated_at')
    .eq('owner_user_id', ownerId)

  const qstats: ActionQueueStats = { pending: 0, approved_today: 0, rejected_today: 0, executed_today: 0 }
  for (const a of allActions ?? []) {
    if (a.status === 'pending') { qstats.pending++; continue }
    const updDate = a.updated_at ? String(a.updated_at).slice(0, 10) : null
    const isToday = updDate === today
    if (a.status === 'approved' && isToday)  qstats.approved_today++
    if (a.status === 'rejected' && isToday)  qstats.rejected_today++
    if (a.status === 'executed' && isToday)  qstats.executed_today++
  }

  // ── 5. Tyr metrics (last 7d) ────────────────────────────────────────────────
  const { data: reviewed } = await db
    .from('seo_content_briefs')
    .select('tyr_score, tyr_status')
    .eq('owner_user_id', ownerId)
    .gte('tyr_reviewed_at', since7d)
    .not('tyr_score', 'is', null)

  const tstats: TyrMetrics = { avg_score: null, reviewed_week: 0, passed: 0, borderline: 0, failed: 0 }
  const scores: number[] = []
  for (const b of reviewed ?? []) {
    tstats.reviewed_week++
    scores.push(Number(b.tyr_score))
    const s = String(b.tyr_status ?? '')
    if      (s === 'reviewed')   tstats.passed++
    else if (s === 'borderline') tstats.borderline++
    else if (s === 'failed')     tstats.failed++
  }
  if (scores.length) tstats.avg_score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)

  // ── 6. GSC latest snapshot ──────────────────────────────────────────────────
  let gscStats: GscStats | null = null
  const { data: gscRows } = await db
    .from('gsc_ranking_snapshots')
    .select('clicks, impressions, snapshot_date')
    .eq('owner_user_id', ownerId)
    .order('snapshot_date', { ascending: false })
    .limit(100)

  if (gscRows?.length) {
    const latestDate = String(gscRows[0].snapshot_date)
    const latest = (gscRows as Array<{ clicks: number; impressions: number; snapshot_date: string }>)
      .filter(r => String(r.snapshot_date) === latestDate)
    const totalClicks      = latest.reduce((s, r) => s + (r.clicks ?? 0), 0)
    const totalImpressions = latest.reduce((s, r) => s + (r.impressions ?? 0), 0)
    gscStats = { total_clicks: totalClicks, total_impressions: totalImpressions, snapshot_date: latestDate }
  }

  return {
    date:           today,
    brief_pipeline: bstats,
    opportunities:  ostats,
    agent_activity: astats,
    action_queue:   qstats,
    tyr_metrics:    tstats,
    gsc:            gscStats,
  }
}

// ── Config-tuning analysers (secondary, unchanged) ────────────────────────────

interface TuneSuggestion {
  headline:        string
  description:     string
  currentConfig:   Record<string, unknown>
  suggestedConfig: Record<string, unknown>
  reasoning:       string
  sampleSize:      number
}

function analyseHeimdall(allActions: ActionRow[], currentConfig: Record<string, unknown>, cfg: VorConfig): TuneSuggestion | null {
  const heimActions = allActions.filter(a => a.agent_key === 'heimdall' && a.action_type === 'add_action_item')
  if (heimActions.length < cfg.minSampleSize) return null
  const lowPri = heimActions.filter(a => a.priority === 'medium')
  const lowResolved = lowPri.filter(a => ['approved', 'executed', 'rejected'].includes(a.status))
  if (lowResolved.length < cfg.minSampleSize) return null
  const rejectRate = lowResolved.filter(a => a.status === 'rejected').length / lowResolved.length
  const minClicksDrop = Number(currentConfig.minClicksDrop ?? 5)
  const minPctDrop    = Number(currentConfig.minPctDrop ?? 20)
  if (rejectRate > cfg.approvalRateThresh) {
    return {
      headline:    `Reduce noise: ${(rejectRate * 100).toFixed(0)}% of medium drops rejected`,
      description: `Over the last ${cfg.configWindowDays} days, you rejected ${(rejectRate * 100).toFixed(0)}% of Heimdall's medium-priority drop alerts (${lowResolved.length} samples).`,
      currentConfig:   { minClicksDrop, minPctDrop },
      suggestedConfig: { minClicksDrop: Math.round(minClicksDrop * 1.4), minPctDrop: Math.round(minPctDrop * 1.2) },
      reasoning:   `High rejection rate suggests thresholds are too lenient.`,
      sampleSize:  lowResolved.length,
    }
  }
  if (rejectRate < (1 - cfg.highConfidenceThresh) && minClicksDrop > 3) {
    return {
      headline:    `Lower threshold: ${((1 - rejectRate) * 100).toFixed(0)}% of medium drops approved`,
      description: `${((1 - rejectRate) * 100).toFixed(0)}% of medium-priority drops were approved (${lowResolved.length} samples). You may be missing smaller drops.`,
      currentConfig:   { minClicksDrop, minPctDrop },
      suggestedConfig: { minClicksDrop: Math.max(3, Math.round(minClicksDrop * 0.8)), minPctDrop: Math.max(10, Math.round(minPctDrop * 0.9)) },
      reasoning:   `Very high approval rate — Heimdall is being conservative.`,
      sampleSize:  lowResolved.length,
    }
  }
  return null
}

function analyseLoki(allActions: ActionRow[], currentConfig: Record<string, unknown>, cfg: VorConfig): TuneSuggestion | null {
  const lokiGaps = allActions.filter(a => a.agent_key === 'loki' && a.action_type === 'add_action_item')
  if (lokiGaps.length < cfg.minSampleSize) return null
  const lowVol = lokiGaps.filter(a => Number(a.data?.search_volume ?? 0) < 1000 && ['approved', 'rejected', 'executed'].includes(a.status))
  if (lowVol.length < cfg.minSampleSize) return null
  const rejectRate = lowVol.filter(a => a.status === 'rejected').length / lowVol.length
  if (rejectRate > 0.7) {
    const cutoff = Number(currentConfig.lowPriorityVolumeCutoff ?? 1000)
    return {
      headline:    `Skip low-volume gaps: ${(rejectRate * 100).toFixed(0)}% rejection rate`,
      description: `${(rejectRate * 100).toFixed(0)}% of gaps under ${cutoff.toLocaleString()} SV were rejected (${lowVol.length} samples).`,
      currentConfig:   { lowPriorityVolumeCutoff: cutoff },
      suggestedConfig: { lowPriorityVolumeCutoff: cutoff * 2 },
      reasoning:   `Raising cutoff to ${(cutoff * 2).toLocaleString()} removes low-yield noise.`,
      sampleSize:  lowVol.length,
    }
  }
  return null
}

function analyseOdin(allActions: ActionRow[], currentConfig: Record<string, unknown>, cfg: VorConfig): TuneSuggestion | null {
  const trends = allActions.filter(a => a.agent_key === 'odin' && a.action_type === 'suggest_trend_brief')
  if (trends.length < cfg.minSampleSize) return null
  const lowPri = trends.filter(a => a.priority === 'low' && ['approved', 'rejected', 'executed'].includes(a.status))
  if (lowPri.length < cfg.minSampleSize) return null
  const rejectRate = lowPri.filter(a => a.status === 'rejected').length / lowPri.length
  if (rejectRate > 0.7 && !Boolean(currentConfig.skipLowPriority)) {
    return {
      headline:    `Skip low-priority trends: ${(rejectRate * 100).toFixed(0)}% rejected`,
      description: `${(rejectRate * 100).toFixed(0)}% of low-priority trend suggestions were rejected (${lowPri.length} samples).`,
      currentConfig:   { skipLowPriority: false },
      suggestedConfig: { skipLowPriority: true },
      reasoning:   `skipLowPriority=true cuts these from the queue at source.`,
      sampleSize:  lowPri.length,
    }
  }
  return null
}

async function analyseTyr(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, ownerId: string, sinceIso: string,
  currentConfig: Record<string, unknown>, cfg: VorConfig,
): Promise<TuneSuggestion | null> {
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('status, tyr_score, tyr_status')
    .eq('owner_user_id', ownerId)
    .gte('tyr_reviewed_at', sinceIso)
    .not('tyr_score', 'is', null)
  const reviewed = (briefs ?? []) as Array<{ status: string; tyr_score: number; tyr_status: string }>
  if (reviewed.length < cfg.minSampleSize) return null
  const minScore      = Number(currentConfig.minScore ?? 80)
  const autoPromoted  = reviewed.filter(b => b.tyr_status === 'reviewed')
  if (autoPromoted.length < cfg.minSampleSize) return null
  const demotedRate   = autoPromoted.filter(b => b.status === 'draft').length / autoPromoted.length
  const publishedRate = autoPromoted.filter(b => b.status === 'published').length / autoPromoted.length
  if (demotedRate > 0.3) {
    return {
      headline:    `Tighten Tyr: ${(demotedRate * 100).toFixed(0)}% auto-promoted briefs demoted`,
      description: `${(demotedRate * 100).toFixed(0)}% of briefs Tyr auto-promoted were manually demoted back to draft.`,
      currentConfig:   { minScore },
      suggestedConfig: { minScore: Math.min(95, minScore + 5) },
      reasoning:   `Tyr is too lenient — raising minScore reduces false-positives.`,
      sampleSize:  autoPromoted.length,
    }
  }
  if (publishedRate > cfg.highConfidenceThresh && minScore > 70) {
    return {
      headline:    `Loosen Tyr: ${(publishedRate * 100).toFixed(0)}% auto-promoted published`,
      description: `${(publishedRate * 100).toFixed(0)}% of Tyr's auto-promoted briefs went to publish without edits.`,
      currentConfig:   { minScore },
      suggestedConfig: { minScore: Math.max(70, minScore - 5) },
      reasoning:   `High publish-without-edit rate — Tyr can afford to be more permissive.`,
      sampleSize:  autoPromoted.length,
    }
  }
  return null
}

// ── Main run ──────────────────────────────────────────────────────────────────

export async function runVor(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<VorConfig> = {}
): Promise<{ summary: string; actionsQueued: number }> {
  const cfg = { ...VOR_DEFAULTS, ...config }
  const db  = createServiceClient()
  const warnings: string[] = []
  let actionsQueued = 0

  try {
    // ── 1. Daily snapshot ─────────────────────────────────────────────────────
    const snapshot = await captureDailySnapshot(db, ownerId)

    // Persist as agent_finding so performance page can chart over time
    await persistFinding(db, {
      agentKey:    'vor',
      ownerId,
      runId,
      siteSlug,
      findingType: 'daily_snapshot',
      subject:     `Daily snapshot — ${snapshot.date}`,
      severity:    'info',
      data:        snapshot as unknown as Record<string, unknown>,
    })

    // ── 2. Config tuning (secondary — only if runConfigTuning && enough data) ─
    if (cfg.runConfigTuning) {
      const sinceIso = new Date(Date.now() - cfg.configWindowDays * 24 * 60 * 60 * 1000).toISOString()
      const { data: actions } = await db
        .from('agent_actions')
        .select('id, agent_key, action_type, priority, status, data, created_at')
        .eq('owner_user_id', ownerId)
        .gte('created_at', sinceIso)

      const { data: agentRows } = await db
        .from('agents')
        .select('agent_key, config')
        .eq('owner_user_id', ownerId)

      const configByAgent = new Map<string, Record<string, unknown>>()
      for (const a of agentRows ?? []) configByAgent.set(a.agent_key as string, (a.config ?? {}) as Record<string, unknown>)

      type AgentSuggestion = { agent_key: string; suggestion: TuneSuggestion }
      const suggestions: AgentSuggestion[] = []

      const h = analyseHeimdall(actions ?? [], configByAgent.get('heimdall') ?? {}, cfg)
      if (h) suggestions.push({ agent_key: 'heimdall', suggestion: h })
      const l = analyseLoki(actions ?? [], configByAgent.get('loki') ?? {}, cfg)
      if (l) suggestions.push({ agent_key: 'loki', suggestion: l })
      const o = analyseOdin(actions ?? [], configByAgent.get('odin') ?? {}, cfg)
      if (o) suggestions.push({ agent_key: 'odin', suggestion: o })
      const t = await analyseTyr(db, ownerId, sinceIso, configByAgent.get('tyr') ?? {}, cfg)
      if (t) suggestions.push({ agent_key: 'tyr', suggestion: t })

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
        if (insertErr) warnings.push(`tune_config insert failed for ${agent_key}`)
        else actionsQueued++
      }
    }

    // ── 3. Build human-readable summary ──────────────────────────────────────
    const s = snapshot
    const summaryParts: string[] = [
      `Daily snapshot ${s.date}:`,
      `Briefs — ${s.brief_pipeline.published} published (${s.brief_pipeline.published_today} today), ${s.brief_pipeline.agent_generated} pending review.`,
    ]
    if (s.opportunities.total > 0) {
      summaryParts.push(`Opportunities — ${s.opportunities.total} total (${s.opportunities.new} new, ${s.opportunities.brief_ready} brief-ready).`)
    }
    if (s.tyr_metrics.reviewed_week > 0) {
      summaryParts.push(`Tyr (7d) — avg score ${s.tyr_metrics.avg_score ?? '—'}, ${s.tyr_metrics.passed} passed, ${s.tyr_metrics.failed} failed.`)
    }
    if (s.gsc) {
      summaryParts.push(`GSC (${s.gsc.snapshot_date}) — ${s.gsc.total_clicks.toLocaleString()} clicks, ${s.gsc.total_impressions.toLocaleString()} impressions.`)
    }
    if (actionsQueued > 0) {
      summaryParts.push(`Config tuning: ${actionsQueued} suggestion${actionsQueued > 1 ? 's' : ''} queued.`)
    }
    if (warnings.length) summaryParts.push(`⚠ ${warnings.join('; ')}`)

    const summary = summaryParts.join(' ')
    const status  = warnings.length ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, summary, 1, actionsQueued, warnings)
    return { summary, actionsQueued }

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', msg, 0, 0, warnings, msg)
    throw err
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId:         string,
  ownerId:       string,
  status:        'success' | 'error' | 'partial',
  summary:       string,
  findingsCount: number,
  actionsQueued: number,
  warnings:      string[],
  errorMessage?: string
) {
  await db.from('agent_runs').update({
    status,
    summary,
    findings_count: findingsCount,
    actions_queued: actionsQueued,
    error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
    finished_at:    new Date().toISOString(),
  }).eq('id', runId)

  await db.from('agents').update({
    last_run_at:      new Date().toISOString(),
    last_run_status:  status,
    last_run_summary: summary,
  }).eq('owner_user_id', ownerId).eq('agent_key', 'vor')
}
