-- Migration: skill_broken_audits
-- Sprint: SKILL.BROKENLINK.1
-- Skill:  searchfit-seo:broken-links
--
-- Stores results of on-demand internal broken-link audits.
-- One row per run; latest row wins via ORDER BY audited_at DESC on read.
--
-- URL sources checked (at audit time):
--   • seo_content_briefs.page      — target pages for drafted/published briefs
--   • tier_serp_snapshots.our_url  — most-recent ranking URL per tracked keyword
--   (g2g_products has no URL column; excluded by design)
--
-- Kill switch: SKILL_BROKENLINK_AUDIT_ENABLED env var (default true).
-- Schema naming convention: skill_<area>_<purpose>.sql

CREATE TABLE IF NOT EXISTS skill_broken_audits (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text        NOT NULL DEFAULT 'g2g',
  audited_at      timestamptz NOT NULL DEFAULT now(),
  -- Summary counters
  total_checked   integer     NOT NULL DEFAULT 0,
  broken_count    integer     NOT NULL DEFAULT 0,   -- HTTP 4xx / 5xx / timeout
  redirect_count  integer     NOT NULL DEFAULT 0,   -- HTTP 3xx
  ok_count        integer     NOT NULL DEFAULT 0,   -- HTTP 2xx
  -- Per-URL results. Shape of each element:
  --   {
  --     url:            string,
  --     status:         number | null,    -- HTTP status code; null on timeout/error
  --     status_text:    string,           -- '404 Not Found' | 'timeout' | etc.
  --     category:       'broken' | 'redirect' | 'ok' | 'error',
  --     source:         'seo_content_briefs' | 'tier_serp_snapshots',
  --     source_label:   string,           -- brief title or keyword
  --     fix_suggestion: string            -- actionable next step
  --   }
  results         jsonb       NOT NULL DEFAULT '[]',
  -- Metadata: how many URLs were collected before dedup/cap
  urls_collected  integer     NOT NULL DEFAULT 0
);

-- Fast lookup: latest audit for a given owner+site
CREATE INDEX IF NOT EXISTS skill_broken_audits_owner_site_idx
  ON skill_broken_audits (owner_user_id, site_slug, audited_at DESC);

ALTER TABLE skill_broken_audits ENABLE ROW LEVEL SECURITY;

-- Owners can read their own audit results
CREATE POLICY "skill_broken_audits_owner_read"
  ON skill_broken_audits FOR SELECT
  USING (auth.uid() = owner_user_id);

-- Writes go through service role only (API route uses createServiceClient)
CREATE POLICY "skill_broken_audits_service_write"
  ON skill_broken_audits FOR INSERT
  WITH CHECK (auth.role() = 'service_role');
