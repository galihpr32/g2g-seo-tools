-- ─────────────────────────────────────────────────────────────────────────────
-- Claude independent brief review (gating mode)
--
-- Adds a second QA gate AFTER Tyr passes. The Cowork-scheduled Claude task
-- polls for briefs at tyr_status='reviewed' AND claude_review_status='pending',
-- runs an independent review focusing on dimensions Tyr doesn't cover (brand
-- voice, internal-link opportunities, SERP fit, FAQ relevance, brand safety),
-- then POSTs the result to /api/automation/claude-review/[briefId].
--
-- Pipeline UI surfaces the intermediate state so Writer Inbox doesn't release
-- the brief to writers until claude_review_status IN ('passed', 'skipped').
--
-- 24-hour timeout safety: if Cowork is offline or Claude review fails, the
-- pipeline-journey GET auto-promotes stale 'pending' rows to 'skipped' so
-- briefs don't get stuck indefinitely.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE seo_content_briefs
  ADD COLUMN IF NOT EXISTS claude_review_status  text
    DEFAULT 'pending'
    CHECK (claude_review_status IN ('pending', 'passed', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS claude_review_score   integer,
  ADD COLUMN IF NOT EXISTS claude_review_notes   text,
  ADD COLUMN IF NOT EXISTS claude_reviewed_at    timestamptz;

-- Polling index for the scheduled Cowork task that fetches "ready for review"
-- briefs every hour. Predicate-only index — small footprint.
CREATE INDEX IF NOT EXISTS seo_content_briefs_pending_claude_review_idx
  ON seo_content_briefs (updated_at)
  WHERE tyr_status = 'reviewed' AND claude_review_status = 'pending';

-- Reporting index: per-status counts for dashboard widget + team-performance.
CREATE INDEX IF NOT EXISTS seo_content_briefs_claude_review_status_idx
  ON seo_content_briefs (claude_review_status, claude_reviewed_at DESC)
  WHERE claude_review_status IS NOT NULL;

-- Backfill: legacy briefs that already passed Tyr before this migration get
-- 'skipped' so they don't suddenly stuck-up Writer Inbox post-deploy.
UPDATE seo_content_briefs
SET    claude_review_status = 'skipped'
WHERE  tyr_status = 'reviewed'
  AND  claude_review_status = 'pending'
  AND  updated_at < NOW() - INTERVAL '1 hour';   -- only briefs already past tyr

-- Verify (run manually):
-- SELECT claude_review_status, COUNT(*)
-- FROM seo_content_briefs
-- GROUP BY claude_review_status
-- ORDER BY 2 DESC;
