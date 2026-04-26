-- Allow 'partial' status on agent_runs and 'agent_generated' on seo_content_briefs.
-- Both were already used in code but the existing CHECK constraints rejected
-- them silently — runs/briefs that should have been recorded got dropped.

-- ── agent_runs.status: add 'partial' ─────────────────────────────────────────
-- agent_runs.status is currently a free-text column with no CHECK, so just
-- document the new value. Code uses 'success' | 'error' | 'partial' |
-- 'running' | 'pending_implementation'. No DDL needed here, kept for
-- documentation / future-proofing if a CHECK is added later.

-- ── seo_content_briefs.status: add 'agent_generated' ─────────────────────────
-- The original migration restricted status to ('generating', 'draft',
-- 'reviewed', 'published') but brief-generator updates rows to
-- 'agent_generated' which fails silently. Fix: drop and re-add the CHECK
-- with the expanded set.

ALTER TABLE seo_content_briefs
  DROP CONSTRAINT IF EXISTS seo_content_briefs_status_check;

ALTER TABLE seo_content_briefs
  ADD CONSTRAINT seo_content_briefs_status_check
  CHECK (status IN ('generating', 'draft', 'agent_generated', 'reviewed', 'published'));

-- ── Index for partial-status agent runs (for dashboard "needs attention") ────
CREATE INDEX IF NOT EXISTS agent_runs_partial_idx
  ON agent_runs (owner_user_id, agent_key, started_at DESC)
  WHERE status = 'partial';
