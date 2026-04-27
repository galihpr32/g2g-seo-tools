-- ════════════════════════════════════════════════════════════════════════════
-- agent_findings — unified discovery / analysis output table
-- ════════════════════════════════════════════════════════════════════════════
--
-- Why this table exists:
-- ----------------------
-- Until now, every agent dumped its conclusions as `agent_actions` (the
-- approval queue). That meant if the user never approved an action, ALL the
-- raw research the agent did (competitor SoV, keyword gaps, ranking-drop
-- analysis, cluster proposals, tune recommendations, etc.) was effectively
-- thrown away — only the "summary" string survived in agent_runs.summary.
--
-- This table captures EVERY meaningful piece of data each agent discovers,
-- regardless of whether an approval action is queued. Pages then read from
-- here so users can browse historical agent output instead of waiting for
-- (or having approved) an action item.
--
-- Approval queue (agent_actions) and findings (agent_findings) serve
-- different purposes:
--   • agent_actions  → "should we ACT on this finding?" (high-signal subset)
--   • agent_findings → "what did the agent observe?" (full discovery feed)
--
-- Schema design:
-- --------------
-- Single wide table with `agent_key` + `finding_type` + jsonb `data` payload.
-- Per-agent type tables would have given stronger types but require a
-- migration per agent and per finding shape; the JSON-per-row pattern lets
-- each agent evolve its findings shape independently while sharing common
-- query infrastructure (RLS, indexes, retention).

CREATE TABLE IF NOT EXISTS agent_findings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_key       text NOT NULL,                -- 'loki' | 'heimdall' | 'saga' | 'vor' | 'odin' | 'hermod' | ...
  run_id          uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  site_slug       text DEFAULT 'g2g',

  -- Finding type — agent-specific. Examples:
  --   loki:     'keyword_gap' | 'sov_snapshot' | 'competitor_summary'
  --   heimdall: 'drop_analysis'
  --   saga:     'cluster_proposal' | 'archive_candidate' | 'coverage_gap'
  --   vor:      'tune_recommendation'
  --   odin:     'trend_score'
  --   hermod:   'prospect_discovered'
  finding_type    text NOT NULL,

  -- Main entity the finding is about (keyword, page URL, cluster name,
  -- competitor domain, target agent name, etc.). Used for de-dupe and
  -- search/filter UI. Free-form — each agent decides what "subject" means
  -- for its finding type.
  subject         text,

  -- Severity / priority hint surfaced in UI. Optional — agents may leave
  -- null and let the UI infer from data (e.g. score thresholds).
  severity        text CHECK (severity IS NULL OR severity IN ('high', 'medium', 'low', 'info')),

  -- Full payload — shape varies per (agent_key, finding_type). See agent
  -- source files for canonical shapes. Pages should treat unknown keys
  -- defensively.
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,

  observed_at     timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common access patterns:
--   1. "latest findings for this user" — page initial load
--   2. "all findings of type X for agent Y" — scoped panels
--   3. "all findings from a specific run" — debug / run detail view
CREATE INDEX IF NOT EXISTS idx_agent_findings_owner_observed
  ON agent_findings(owner_user_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_findings_agent_type
  ON agent_findings(owner_user_id, agent_key, finding_type, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_findings_run
  ON agent_findings(run_id);

CREATE INDEX IF NOT EXISTS idx_agent_findings_subject
  ON agent_findings(owner_user_id, agent_key, subject, observed_at DESC)
  WHERE subject IS NOT NULL;

-- RLS — same pattern as agent_runs / agent_actions
ALTER TABLE agent_findings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_findings_owner_select" ON agent_findings;
CREATE POLICY "agent_findings_owner_select"
  ON agent_findings FOR SELECT
  USING (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "agent_findings_service_all" ON agent_findings;
CREATE POLICY "agent_findings_service_all"
  ON agent_findings FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE  agent_findings IS 'Per-agent discovery/analysis output. One row per finding. Read by /competitive, /gsc/ranking-drop, /command-center/tuning, etc.';
COMMENT ON COLUMN agent_findings.finding_type IS 'See agent source for canonical types per agent_key.';
COMMENT ON COLUMN agent_findings.data IS 'Shape varies per (agent_key, finding_type). Treat unknown keys defensively in UI.';
