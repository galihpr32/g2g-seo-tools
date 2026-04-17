-- ============================================================
-- Campaign Enhancements
-- - status + notes on campaigns
-- - status + notes + eta on campaign_pages
-- - campaign_page_comments table
-- ============================================================

-- ── campaigns: add status + notes ────────────────────────────────────────────
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'completed', 'paused')),
  ADD COLUMN IF NOT EXISTS campaign_notes text;

-- ── campaign_pages: add status + notes + eta ─────────────────────────────────
ALTER TABLE campaign_pages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'done')),
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS eta date;

-- ── campaign_page_comments ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_page_comments (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_page_id uuid NOT NULL REFERENCES campaign_pages(id) ON DELETE CASCADE,
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_email     text NOT NULL,
  content          text NOT NULL,
  created_at       timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaign_page_comments_page
  ON campaign_page_comments (campaign_page_id, created_at);

ALTER TABLE campaign_page_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaign_page_comments: owner full access"
  ON campaign_page_comments FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
