import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Agent activity insights for weekly + monthly reports.
 *
 * Aggregates `agent_runs` + `agent_actions` + `seo_content_briefs`
 * activity within a date window and shapes it for both:
 *  - render in the report UI ("Agent Activity Summary" card)
 *  - inclusion in the Claude narrative prompt (gives the model causal
 *    context — "Bragi drafted 8 briefs from 3 Heimdall critical drops" —
 *    so the narrative connects detection → action → outcome).
 *
 * Single query batch per call. Failures are non-fatal: returns empty
 * insights with a warning string so the report still generates.
 */

export interface AgentInsights {
  windowStart:    string
  windowEnd:      string
  totals: {
    runs:           number
    runsByStatus:   Record<string, number>   // success | partial | error | running
    actionsQueued:  number
    actionsApproved: number
    actionsRejected: number
    actionsExecuted: number
  }
  byAgent: Array<{
    agent_key:     string
    runs:          number
    success:       number
    partial:       number
    error:         number
    actionsQueued: number
    approvalRate:  number | null   // approved / (approved + rejected); null if no resolved actions
  }>
  highlights: {
    heimdallDrops:        Highlight[]   // top page drops detected this window
    lokiGaps:             Highlight[]   // top competitive gaps by SV
    odinTrends:           Highlight[]   // trending games queued
    fastPathHandoffs:     number        // run_agent actions queued (cross-agent chain triggered)
    bragiBriefsDrafted:   number
    tyrReviewed: {
      total:      number
      promoted:   number
      borderline: number
      failed:     number
      avgScore:   number | null
    }
    sagaActivity: {
      clusterProposals:  number
      newTopics:         number
      archived:          number
      coverageReviews:   number
    }
    vorTunings:          number   // tune_config actions queued
    hermodProspects:     number   // draft_outreach actions queued
  }
  warnings: string[]
}

interface Highlight {
  title:    string
  detail:   string
  metric?:  number
  agent?:   string
}

const DEFAULT_INSIGHTS: AgentInsights = {
  windowStart: '',
  windowEnd:   '',
  totals: {
    runs: 0, runsByStatus: {}, actionsQueued: 0, actionsApproved: 0, actionsRejected: 0, actionsExecuted: 0,
  },
  byAgent: [],
  highlights: {
    heimdallDrops:      [],
    lokiGaps:           [],
    odinTrends:         [],
    fastPathHandoffs:   0,
    bragiBriefsDrafted: 0,
    tyrReviewed:        { total: 0, promoted: 0, borderline: 0, failed: 0, avgScore: null },
    sagaActivity:       { clusterProposals: 0, newTopics: 0, archived: 0, coverageReviews: 0 },
    vorTunings:         0,
    hermodProspects:    0,
  },
  warnings: [],
}

/**
 * Compute agent insights for a date window. Both bounds inclusive.
 * `windowStart` and `windowEnd` are ISO date strings (YYYY-MM-DD).
 */
export async function getAgentInsights(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:           SupabaseClient<any, any, any>,
  ownerId:      string,
  windowStart:  string,
  windowEnd:    string,
): Promise<AgentInsights> {
  const insights: AgentInsights = {
    ...structuredClone(DEFAULT_INSIGHTS),
    windowStart,
    windowEnd,
  }

  const startIso = `${windowStart}T00:00:00`
  const endIso   = `${windowEnd}T23:59:59`

  // Pull everything in parallel
  const [runsRes, actionsRes, briefsRes] = await Promise.all([
    db
      .from('agent_runs')
      .select('id, agent_key, status, started_at, finished_at, actions_queued, findings_count')
      .eq('owner_user_id', ownerId)
      .gte('started_at', startIso)
      .lte('started_at', endIso),
    db
      .from('agent_actions')
      .select('id, agent_key, action_type, status, priority, data, created_at')
      .eq('owner_user_id', ownerId)
      .gte('created_at', startIso)
      .lte('created_at', endIso),
    db
      .from('seo_content_briefs')
      .select('id, status, tyr_score, tyr_status, tyr_reviewed_at, created_at')
      .eq('owner_user_id', ownerId)
      .gte('tyr_reviewed_at', startIso)
      .lte('tyr_reviewed_at', endIso)
      .not('tyr_score', 'is', null),
  ])

  if (runsRes.error)    insights.warnings.push(`agent_runs query failed: ${runsRes.error.message}`)
  if (actionsRes.error) insights.warnings.push(`agent_actions query failed: ${actionsRes.error.message}`)
  if (briefsRes.error)  insights.warnings.push(`seo_content_briefs query failed: ${briefsRes.error.message}`)

  const runs    = (runsRes.data    ?? []) as Array<{ agent_key: string; status: string; actions_queued: number | null; findings_count: number | null }>
  const actions = (actionsRes.data ?? []) as Array<{ agent_key: string; action_type: string; status: string; priority: string | null; data: Record<string, unknown> | null }>
  const briefs  = (briefsRes.data  ?? []) as Array<{ tyr_score: number | null; tyr_status: string | null }>

  // ── Totals ────────────────────────────────────────────────────────────────
  insights.totals.runs = runs.length
  for (const r of runs) {
    insights.totals.runsByStatus[r.status] = (insights.totals.runsByStatus[r.status] ?? 0) + 1
  }

  for (const a of actions) {
    if (a.status === 'pending')        insights.totals.actionsQueued++
    else if (a.status === 'approved')  insights.totals.actionsApproved++
    else if (a.status === 'rejected')  insights.totals.actionsRejected++
    else if (a.status === 'executed')  insights.totals.actionsExecuted++
  }

  // ── Per-agent breakdown ──────────────────────────────────────────────────
  const agentSet = new Set([...runs.map(r => r.agent_key), ...actions.map(a => a.agent_key)])
  for (const agent of agentSet) {
    const agentRuns    = runs.filter(r => r.agent_key === agent)
    const agentActions = actions.filter(a => a.agent_key === agent)
    const resolved     = agentActions.filter(a => ['approved', 'executed', 'rejected'].includes(a.status))
    const positive     = resolved.filter(a => ['approved', 'executed'].includes(a.status))
    insights.byAgent.push({
      agent_key:     agent,
      runs:          agentRuns.length,
      success:       agentRuns.filter(r => r.status === 'success').length,
      partial:       agentRuns.filter(r => r.status === 'partial').length,
      error:         agentRuns.filter(r => r.status === 'error').length,
      actionsQueued: agentActions.length,
      approvalRate:  resolved.length > 0 ? positive.length / resolved.length : null,
    })
  }
  // Sort by activity desc
  insights.byAgent.sort((a, b) => (b.runs + b.actionsQueued) - (a.runs + a.actionsQueued))

  // ── Highlights ───────────────────────────────────────────────────────────

  // Heimdall: top drops
  const heimdallActions = actions.filter(a => a.agent_key === 'heimdall')
  insights.highlights.heimdallDrops = heimdallActions
    .map(a => {
      const d = a.data ?? {}
      const page  = String(d.page ?? '')
      const drop  = Number(d.clicks_drop      ?? 0)
      const pct   = Number(d.clicks_drop_pct  ?? 0)
      return {
        title:  page.replace(/^https?:\/\/[^/]+/, ''),
        detail: `-${drop} clicks (-${pct.toFixed(0)}%)`,
        metric: pct,
        agent:  'heimdall',
      }
    })
    .filter(h => h.metric !== undefined && h.metric > 0)
    .sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))
    .slice(0, 5)

  // Loki: top competitive gaps
  const lokiActions = actions.filter(a => a.agent_key === 'loki')
  insights.highlights.lokiGaps = lokiActions
    .map(a => {
      const d = a.data ?? {}
      const kw   = String(d.keyword ?? '')
      const sv   = Number(d.search_volume ?? 0)
      const comp = String(d.competitor_domain ?? '')
      const pos  = d.competitor_position
      return {
        title:  kw,
        detail: `${sv.toLocaleString()} SV · ${comp}${pos ? ` #${pos}` : ''}`,
        metric: sv,
        agent:  'loki',
      }
    })
    .filter(h => h.title)
    .sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))
    .slice(0, 5)

  // Odin: trending games
  const odinActions = actions.filter(a => a.agent_key === 'odin')
  insights.highlights.odinTrends = odinActions
    .map(a => {
      const d = a.data ?? {}
      const game = String(d.game_name ?? '')
      const sv   = Number(d.search_volume  ?? 0)
      const p2w  = Number(d.players_2weeks ?? 0)
      return {
        title:  game,
        detail: `${sv.toLocaleString()} SV · ${(p2w / 1000).toFixed(0)}K players`,
        metric: Number(d.trend_score ?? sv),
        agent:  'odin',
      }
    })
    .filter(h => h.title)
    .sort((a, b) => (b.metric ?? 0) - (a.metric ?? 0))
    .slice(0, 5)

  // Fast-path handoffs (run_agent actions)
  insights.highlights.fastPathHandoffs = actions.filter(a => a.action_type === 'run_agent').length

  // Bragi briefs drafted
  insights.highlights.bragiBriefsDrafted = actions.filter(
    a => a.agent_key === 'bragi' && a.action_type === 'draft_brief'
  ).length

  // Tyr reviewed briefs
  if (briefs.length > 0) {
    insights.highlights.tyrReviewed.total      = briefs.length
    insights.highlights.tyrReviewed.promoted   = briefs.filter(b => b.tyr_status === 'reviewed').length
    insights.highlights.tyrReviewed.borderline = briefs.filter(b => b.tyr_status === 'borderline').length
    insights.highlights.tyrReviewed.failed     = briefs.filter(b => b.tyr_status === 'failed').length
    const sumScore = briefs.reduce((s, b) => s + (b.tyr_score ?? 0), 0)
    insights.highlights.tyrReviewed.avgScore = Math.round(sumScore / briefs.length)
  }

  // Saga activity
  insights.highlights.sagaActivity = {
    clusterProposals: actions.filter(a => a.agent_key === 'saga' && a.action_type === 'add_to_cluster').length,
    newTopics:        actions.filter(a => a.agent_key === 'saga' && a.action_type === 'create_topic_map').length,
    archived:         actions.filter(a => a.agent_key === 'saga' && a.action_type === 'archive_cluster').length,
    coverageReviews:  actions.filter(a => a.agent_key === 'saga' && a.action_type === 'coverage_review').length,
  }

  // Vor tunings
  insights.highlights.vorTunings = actions.filter(
    a => a.agent_key === 'vor' && a.action_type === 'tune_config'
  ).length

  // Hermod prospects
  insights.highlights.hermodProspects = actions.filter(
    a => a.agent_key === 'hermod' && a.action_type === 'draft_outreach'
  ).length

  return insights
}

/**
 * Render insights as a compact prose block for inclusion in the Claude
 * narrative prompt. Keeps tokens low — single paragraph + bullet line.
 */
export function formatInsightsForPrompt(insights: AgentInsights): string {
  const t = insights.totals
  const h = insights.highlights
  if (t.runs === 0 && Object.values(h).every(v => Array.isArray(v) ? v.length === 0 : !v)) {
    return 'AGENT ACTIVITY: no agent runs in this window.'
  }

  const lines: string[] = []
  lines.push(`AGENT ACTIVITY (${insights.windowStart} → ${insights.windowEnd}):`)
  lines.push(`- Runs: ${t.runs} (success ${t.runsByStatus.success ?? 0}, partial ${t.runsByStatus.partial ?? 0}, error ${t.runsByStatus.error ?? 0})`)
  lines.push(`- Actions queued: ${t.actionsQueued} pending, ${t.actionsApproved} approved, ${t.actionsExecuted} executed, ${t.actionsRejected} rejected`)
  if (h.fastPathHandoffs > 0) lines.push(`- Fast-path handoffs (cross-agent chain): ${h.fastPathHandoffs}`)
  if (h.heimdallDrops.length > 0) lines.push(`- Heimdall flagged ${h.heimdallDrops.length} significant drops (top: ${h.heimdallDrops[0].title} ${h.heimdallDrops[0].detail})`)
  if (h.lokiGaps.length > 0)     lines.push(`- Loki found ${h.lokiGaps.length} competitive gaps (top: "${h.lokiGaps[0].title}", ${h.lokiGaps[0].detail})`)
  if (h.odinTrends.length > 0)   lines.push(`- Odin surfaced ${h.odinTrends.length} trending opportunities (top: ${h.odinTrends[0].title})`)
  if (h.bragiBriefsDrafted > 0)  lines.push(`- Bragi drafted ${h.bragiBriefsDrafted} content briefs`)
  if (h.tyrReviewed.total > 0)   lines.push(`- Tyr reviewed ${h.tyrReviewed.total} briefs (avg score ${h.tyrReviewed.avgScore}/100, ${h.tyrReviewed.promoted} auto-promoted, ${h.tyrReviewed.borderline} borderline, ${h.tyrReviewed.failed} failed)`)
  if (h.sagaActivity.clusterProposals + h.sagaActivity.newTopics + h.sagaActivity.archived > 0) {
    lines.push(`- Saga curation: ${h.sagaActivity.clusterProposals} cluster proposals, ${h.sagaActivity.newTopics} new topics, ${h.sagaActivity.archived} archived`)
  }
  if (h.vorTunings > 0)        lines.push(`- Vor proposed ${h.vorTunings} threshold tunings`)
  if (h.hermodProspects > 0)   lines.push(`- Hermod sourced ${h.hermodProspects} outreach prospects`)

  lines.push('')
  lines.push('Use this to connect cause-and-effect in your narrative when relevant — e.g. "X clicks recovered from pages Heimdall flagged 3 weeks ago" or "Y new keywords from Loki gaps now ranking".')
  return lines.join('\n')
}
