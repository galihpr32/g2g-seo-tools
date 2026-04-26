-- Migration: Tyr (Reviewer) + Mimir (Config Tuner) infrastructure.

-- ── seo_content_briefs: add Tyr review fields ───────────────────────────────
ALTER TABLE seo_content_briefs
  ADD COLUMN IF NOT EXISTS tyr_score        smallint,         -- 0-100, last Tyr review
  ADD COLUMN IF NOT EXISTS tyr_reviewed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS tyr_breakdown    jsonb,            -- {coverage, intent_match, keyword_grounding, faq_realism, redflags[]}
  ADD COLUMN IF NOT EXISTS tyr_status       text;             -- 'reviewed' | 'borderline' | 'failed' | 'error'

-- Index for Tyr's "find unreviewed briefs" query
CREATE INDEX IF NOT EXISTS seo_content_briefs_tyr_pending_idx
  ON seo_content_briefs (owner_user_id, status, tyr_reviewed_at)
  WHERE status = 'agent_generated' AND tyr_reviewed_at IS NULL;

-- Index for "show me high-quality reviewed briefs" filter on the dashboard
CREATE INDEX IF NOT EXISTS seo_content_briefs_tyr_score_idx
  ON seo_content_briefs (owner_user_id, tyr_score DESC)
  WHERE tyr_score IS NOT NULL;

-- ── agent_actions: allow new action_types ───────────────────────────────────
-- agent_actions.action_type was free-text — kept that way intentionally
-- (different agents queue different types). The new types are:
--   'tune_config'      — Mimir suggests adjusting agents.config
--   'regenerate_brief' — Tyr requests Bragi to re-draft a brief that scored <60
-- No schema change needed.

-- ── seed Tyr + Mimir agents row per existing owner ──────────────────────────
-- agents table is per-owner-per-key; rows get auto-created when first run.
-- We don't seed here because creation happens in the run route. Just ensure
-- the table accepts the new keys (no enum constraint on agent_key).

-- ── Default config for Tyr + Mimir (documentation only) ────────────────────
-- Tyr   config (agents.config jsonb):
--   minScore:         number  // default 80 — auto-promote threshold
--   borderlineWindow: number  // default 10 — score in [minScore-borderlineWindow, minScore-1] = 'borderline'
--   maxBriefsPerDay:  number  // default 30 — rate limit
--   schedule_enabled: boolean // default false until owner enables
--
-- Mimir config:
--   minSampleSize:        number  // default 10 — minimum actions/briefs needed before suggesting tuning
--   approvalRateThresh:   number  // default 0.5 — reject_rate above this triggers tighten suggestion
--   highConfidenceThresh: number  // default 0.85 — approval_rate above this triggers loosen suggestion
--   schedule_enabled:     boolean

-- ── tune_config audit log ───────────────────────────────────────────────────
-- When user approves a tune_config suggestion, we want to keep the previous
-- config so a "rollback" is possible.
CREATE TABLE IF NOT EXISTS agent_config_history (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_key       text        NOT NULL,
  applied_by      uuid        REFERENCES auth.users(id),
  source          text        NOT NULL,    -- 'mimir_suggestion' | 'manual_ui' | 'rollback'
  source_action_id uuid       REFERENCES agent_actions(id),
  config_before   jsonb,
  config_after    jsonb       NOT NULL,
  reasoning       text,
  applied_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_config_history_lookup_idx
  ON agent_config_history (owner_user_id, agent_key, applied_at DESC);

ALTER TABLE agent_config_history ENABLE ROW LEVEL SECURITY;

-- Owners can read their own config history
CREATE POLICY "owners read own config history" ON agent_config_history
  FOR SELECT USING (owner_user_id = auth.uid());
