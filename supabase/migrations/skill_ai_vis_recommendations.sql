-- Migration: skill_ai_vis_recommendations
-- Sprint: SKILL.AI_VIS.1
-- Purpose: Stores AI visibility actionable recommendations generated via
--          the searchfit-seo:ai-visibility skill (Claude Haiku). One row per
--          (owner, site, snapshot_date) — re-generation overwrites via insert
--          (latest row wins via ORDER BY generated_at DESC on read).
--
-- Kill switch: SKILL_AI_VIS_RECOMMENDATIONS_ENABLED env var (default true).
-- Schema naming convention: skill_<area>_<purpose>.

CREATE TABLE IF NOT EXISTS skill_ai_vis_recommendations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text        NOT NULL DEFAULT 'g2g',
  -- The ai_visibility_snapshots.snapshot_date (date string) this was generated from.
  -- Used to skip re-generation when the user has not imported newer data.
  snapshot_date   date        NOT NULL,
  -- Array of recommendation objects. Shape:
  --   { title, action, metric, rationale, priority: 'high'|'medium'|'low',
  --     dimension: 'content'|'technical'|'authority'|'prompt_optimization' }
  -- Validated before insert: each item must start with action verb + have metric.
  recommendations jsonb       NOT NULL DEFAULT '[]',
  generated_at    timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup: latest recommendation for a given owner+site
CREATE INDEX IF NOT EXISTS skill_ai_vis_rec_owner_site_idx
  ON skill_ai_vis_recommendations(owner_user_id, site_slug, generated_at DESC);

-- Lookup by snapshot_date (used by POST to check if already generated)
CREATE INDEX IF NOT EXISTS skill_ai_vis_rec_snapshot_idx
  ON skill_ai_vis_recommendations(owner_user_id, site_slug, snapshot_date);

ALTER TABLE skill_ai_vis_recommendations ENABLE ROW LEVEL SECURITY;

-- Owners can read their own recommendations (page-level GET)
CREATE POLICY "skill_ai_vis_rec_owner_read"
  ON skill_ai_vis_recommendations FOR SELECT
  USING (auth.uid() = owner_user_id);

-- Writes go through service role only (API route uses createServiceClient)
CREATE POLICY "skill_ai_vis_rec_service_write"
  ON skill_ai_vis_recommendations FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
