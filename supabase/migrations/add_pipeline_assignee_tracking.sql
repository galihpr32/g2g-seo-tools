-- ─────────────────────────────────────────────────────────────────────────────
-- Pipeline Journey assignee tracking
--
-- Captures WHO did what at each pipeline stage so:
--   1. UI can show "Approved by [user]" on opp cards
--   2. /team-performance page can aggregate per-user activity
--   3. Audit trail exists for who shipped which brief
--
-- Existing tracking already in place (do NOT recreate):
--   - seo_action_items.assigned_to                   (covered by team-performance)
--   - brief_outcomes.published_at (date only, no by)
--
-- New columns added here:
--   - seo_opportunities:    approved_by/at, dismissed_by/at
--   - seo_content_briefs:   published_by/at, assigned_to, assigned_at
--   - outreach_prospects:   claimed_by, claimed_at
-- ─────────────────────────────────────────────────────────────────────────────

-- ── seo_opportunities ────────────────────────────────────────────────────────
ALTER TABLE seo_opportunities
  ADD COLUMN IF NOT EXISTS approved_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS dismissed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dismissed_at  timestamptz;

-- Index for reporting: count approvals per user
CREATE INDEX IF NOT EXISTS seo_opportunities_approved_by_at_idx
  ON seo_opportunities (approved_by, approved_at DESC)
  WHERE approved_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS seo_opportunities_dismissed_by_at_idx
  ON seo_opportunities (dismissed_by, dismissed_at DESC)
  WHERE dismissed_by IS NOT NULL;

-- ── seo_content_briefs ───────────────────────────────────────────────────────
ALTER TABLE seo_content_briefs
  ADD COLUMN IF NOT EXISTS published_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS published_at  timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_to   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at   timestamptz;

CREATE INDEX IF NOT EXISTS seo_content_briefs_published_by_at_idx
  ON seo_content_briefs (published_by, published_at DESC)
  WHERE published_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS seo_content_briefs_assigned_to_idx
  ON seo_content_briefs (assigned_to)
  WHERE assigned_to IS NOT NULL;

-- ── outreach_prospects ───────────────────────────────────────────────────────
ALTER TABLE outreach_prospects
  ADD COLUMN IF NOT EXISTS claimed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at  timestamptz;

CREATE INDEX IF NOT EXISTS outreach_prospects_claimed_by_at_idx
  ON outreach_prospects (claimed_by, claimed_at DESC)
  WHERE claimed_by IS NOT NULL;

-- Verify (run manually):
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_name IN ('seo_opportunities', 'seo_content_briefs', 'outreach_prospects')
--   AND column_name IN ('approved_by','approved_at','dismissed_by','dismissed_at',
--                       'published_by','published_at','assigned_to','assigned_at',
--                       'claimed_by','claimed_at')
-- ORDER BY table_name, column_name;
