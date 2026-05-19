-- Migration: skill_intlink_audits
-- Sprint: SKILL.INTLINK.1
-- Skill:  searchfit-seo:internal-linking
--
-- Stores strategic internal-linking recommendations generated via Claude Haiku
-- using the internal-linking skill methodology. One row per generation;
-- latest row wins via ORDER BY generated_at DESC on read.
--
-- Rate limit: 1 per 7 days per (owner, site) — checked in POST handler.
-- Kill switch: SKILL_INTLINK_AUDIT_ENABLED env var (default true).
-- Schema naming convention: skill_<area>_<purpose>.sql

CREATE TABLE IF NOT EXISTS skill_intlink_recommendations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug         text        NOT NULL DEFAULT 'g2g',
  generated_at      timestamptz NOT NULL DEFAULT now(),
  -- Site state snapshot at generation time (stored for UI context)
  orphan_count      integer     NOT NULL DEFAULT 0,
  opportunity_count integer     NOT NULL DEFAULT 0,
  total_pages       integer     NOT NULL DEFAULT 0,
  avg_inlinks       numeric(6,2) NOT NULL DEFAULT 0,
  -- Array of recommendation objects. Shape:
  --   { title, action, target, priority: 'high'|'medium'|'low',
  --     category: 'orphan_fix'|'hub_spoke'|'cluster_link'|'anchor_text'|'equity_flow' }
  -- Validated before insert: each action must start with an action verb.
  recommendations   jsonb       NOT NULL DEFAULT '[]'
);

-- Fast lookup: latest rec for a given owner+site
CREATE INDEX IF NOT EXISTS skill_intlink_rec_owner_site_idx
  ON skill_intlink_recommendations (owner_user_id, site_slug, generated_at DESC);

ALTER TABLE skill_intlink_recommendations ENABLE ROW LEVEL SECURITY;

-- Owners can read their own recommendations
CREATE POLICY "skill_intlink_rec_owner_read"
  ON skill_intlink_recommendations FOR SELECT
  USING (auth.uid() = owner_user_id);

-- Writes go through service role only (API route uses createServiceClient)
CREATE POLICY "skill_intlink_rec_service_write"
  ON skill_intlink_recommendations FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
