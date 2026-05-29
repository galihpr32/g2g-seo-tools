import type { createServiceClient } from '@/lib/supabase/service'

/**
 * agent_findings persistence helper.
 *
 * Why this file exists:
 * ---------------------
 * Every agent now writes raw discovery/analysis data to `agent_findings`
 * regardless of whether an approval action is queued. This way pages can
 * surface "what did the agent see?" historically, not just "what's pending
 * approval right now?".
 *
 * Each agent's finding shapes are documented in the type unions below.
 * Adding a new finding type:
 *   1. Add the literal to `FindingType` union for the agent
 *   2. Add the data shape to `FindingDataMap` (or extend an existing one)
 *   3. Call `persistFinding(...)` from inside the agent's run loop
 *
 * Failure mode: if persistence fails, we log + warn but never throw — the
 * agent's main run should not be derailed by a findings write failure.
 */

type Db = ReturnType<typeof createServiceClient>

type Severity = 'high' | 'medium' | 'low' | 'info' | null

interface PersistFindingArgs {
  agentKey:     string
  ownerId:      string
  runId:        string
  siteSlug?:    string
  findingType:  string
  subject?:     string | null
  severity?:    Severity
  data:         Record<string, unknown>
}

export async function persistFinding(
  db: Db,
  args: PersistFindingArgs
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await db.from('agent_findings').insert({
    owner_user_id: args.ownerId,
    agent_key:     args.agentKey,
    run_id:        args.runId,
    site_slug:     args.siteSlug ?? 'g2g',
    finding_type:  args.findingType,
    subject:       args.subject ?? null,
    severity:      args.severity ?? null,
    data:          args.data,
  })
  if (error) {
    // Soft-fail: log but never throw. A findings write failure should not
    // sink the agent's actual run.
    console.error(`[findings] insert failed (${args.agentKey}/${args.findingType}):`, error.message)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Bulk insert variant — preferable when an agent has many findings of the
 * same shape (e.g. Loki has dozens of keyword_gap findings per run).
 */
export async function persistFindingsBulk(
  db: Db,
  findings: PersistFindingArgs[]
): Promise<{ inserted: number; failed: number }> {
  if (findings.length === 0) return { inserted: 0, failed: 0 }

  const rows = findings.map(f => ({
    owner_user_id: f.ownerId,
    agent_key:     f.agentKey,
    run_id:        f.runId,
    site_slug:     f.siteSlug ?? 'g2g',
    finding_type:  f.findingType,
    subject:       f.subject ?? null,
    severity:      f.severity ?? null,
    data:          f.data,
  }))

  const { error, count } = await db
    .from('agent_findings')
    .insert(rows, { count: 'exact' })

  if (error) {
    console.error(`[findings] bulk insert failed (${findings.length} rows):`, error.message)
    return { inserted: 0, failed: findings.length }
  }
  return { inserted: count ?? findings.length, failed: 0 }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Canonical finding-data shapes (documentation + type hints for callers).
 * Pages should treat unknown keys defensively but these capture the common
 * core each agent writes.
 * ───────────────────────────────────────────────────────────────────────── */

export interface LokiKeywordGapData {
  keyword:              string
  competitor_domain:    string
  competitor_position:  number
  competitor_url:       string | null
  our_position:         number | null
  search_volume:        number
  cpc?:                 number
  queued_as_action?:    boolean        // did we also queue an agent_action?
  is_high_value?:       boolean        // ≥10k SV gap?
  topic?:               string | null  // from universe lookup
  outside_universe?:    boolean
}

export interface LokiSovSnapshotData {
  our_domain:                 string
  our_recent_sov:             number   // top-10 keyword count (recent window)
  our_older_sov:              number   // top-10 keyword count (older window)
  sov_change:                 number   // recent - older
  sov_change_pct:             number
  top_competitors_recent:     [string, number][]   // [[domain, sov], ...] descending
  top_competitors_older:      [string, number][]
  lost_keywords:              string[]              // sample of keywords we dropped from top-10
  recent_window_start:        string                // ISO date
  older_window_start:         string
  total_keywords_tracked:     number
  triggered_action?:          boolean
}

export interface LokiCompetitorSummaryData {
  domain:               string
  total_keywords:       number       // total ranked keywords from DataForSEO
  top10_count:          number       // how many in top-10
  gaps_found:           number       // gaps where we don't rank but they do
  sample_gap_keywords:  string[]     // first few for preview
}

export interface HeimdallDropAnalysisData {
  page:                 string
  clicks_drop:          number
  pct_drop:             number
  position_diff:        number | null
  category:             'algorithmic' | 'technical' | 'content' | 'unknown'
  reasoning:            string
  top_dropped_queries:  { query: string; clicks_drop: number }[]
  recommendation:       string
  // Structured fix checklist injected by technical-SEO + SEO-audit methodology.
  // Steps are ordered by urgency — first item is the highest-priority action.
  fix_checklist?:       { step: string; priority: 'immediate' | 'high' | 'medium' }[]
  // Rough recovery potential based on root-cause category:
  //   high   = technical issue (usually fast to fix — indexation, schema, snippet)
  //   medium = content refresh needed (weeks)
  //   low    = algorithmic / backlink-driven (months)
  recovery_potential?:  'high' | 'medium' | 'low'
}

export interface SagaProposalData {
  proposal_type:    'cluster' | 'archive' | 'coverage_gap'
  cluster_name?:    string
  keywords?:        string[]
  reasoning:        string
  affected_count?:  number
}

export interface VorTuneRecommendationData {
  target_agent:     string             // 'heimdall' | 'loki' | 'odin' | 'tyr' | ...
  parameter:        string             // 'minClicks' | 'minScore' | ...
  current_value:    number | string
  suggested_value:  number | string
  reasoning:        string
  confidence:       number             // 0-1
  metric_basis:     string             // e.g. "approval_rate=0.9 over last 30 actions"
}

export interface OdinTrendScoreData {
  steam_appid:    number
  game_name:      string
  priority:       'high' | 'medium' | 'low'
  score:          number               // 0-100
  reasoning:      string
  signals:        {
    players_2weeks?:   number
    search_volume?:    number
    g2g_recommended?:  boolean
  }
  queued_as_brief?: boolean
  // Content strategy derived per game using the content-strategy skill methodology.
  // Classifies intent, recommends content type, and suggests a specific content angle
  // for Bragi's brief prompt — so Bragi gets direction, not just a keyword.
  content_strategy?: {
    intent:            'informational' | 'commercial' | 'transactional' | 'mixed'
    content_type:      'category_page' | 'buying_guide' | 'game_guide' | 'comparison'
    content_angle:     string   // specific headline direction for the brief
    pillar_or_cluster: 'pillar' | 'cluster' | 'standalone'
  }
}
