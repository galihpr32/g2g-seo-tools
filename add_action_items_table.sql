-- ─────────────────────────────────────────────────────────────────────────────
-- SEO Action Items table
-- Stores pages selected from Ranking Drop for follow-up optimization tasks.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seo_action_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_url        text        NOT NULL,
  page            text        NOT NULL,
  action_type     text        NOT NULL CHECK (action_type IN ('on_page', 'off_page')),
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'in_progress', 'done')),
  notes           text,
  snapshot_date   date        NOT NULL,  -- which ranking-drop snapshot triggered this
  clicks_drop     numeric,               -- context: how bad was the drop
  position_change numeric,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- ── Indexes ────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_seo_action_items_site_status
  ON seo_action_items (site_url, status);

CREATE INDEX IF NOT EXISTS idx_seo_action_items_snapshot_date
  ON seo_action_items (snapshot_date);

-- ── Row Level Security ─────────────────────────────────────────────────────────
ALTER TABLE seo_action_items ENABLE ROW LEVEL SECURITY;

-- Read: users can only see action items for their own connected site
CREATE POLICY "Users read own action items"
  ON seo_action_items FOR SELECT
  USING (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

-- Insert: users can only create items for their own site
CREATE POLICY "Users insert own action items"
  ON seo_action_items FOR INSERT
  WITH CHECK (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

-- Update: users can only update their own items (e.g. toggle status)
CREATE POLICY "Users update own action items"
  ON seo_action_items FOR UPDATE
  USING (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

-- Service role can do everything (for cron jobs etc.)
CREATE POLICY "Service role full access to action items"
  ON seo_action_items
  USING (auth.role() = 'service_role');
