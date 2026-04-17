-- ─────────────────────────────────────────────────────────────────────────────
-- SEO Content Briefs table
-- Stores AI-generated on-page and off-page content briefs linked to action items.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seo_content_briefs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_url         text        NOT NULL,
  action_item_id   uuid        REFERENCES seo_action_items(id) ON DELETE CASCADE,
  page             text        NOT NULL,
  brief_type       text        NOT NULL CHECK (brief_type IN ('on_page', 'off_page')),

  -- Status lifecycle: generating → draft → reviewed → published
  status           text        NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('generating', 'draft', 'reviewed', 'published')),

  -- On-page brief fields
  current_content_summary  text,         -- what the page currently says
  content_gaps             text[],       -- what's missing vs competitors
  primary_keyword          text,         -- main target keyword
  new_keywords             jsonb,        -- [{keyword, volume, difficulty}]
  longtail_keywords        jsonb,        -- [{keyword, volume, intent}]
  faq_suggestions          jsonb,        -- [{question, suggested_answer}]
  content_draft            text,         -- full AI-written content draft
  content_outline          jsonb,        -- structured outline [{h2, notes}]

  -- Off-page brief fields
  topic                    text,         -- derived from URL slug
  content_ideas            jsonb,        -- [{title, angle, target_keyword, platform, priority}]
  competitor_analysis      jsonb,        -- [{url, title, angle}] - what's ranking
  off_page_draft           text,         -- full draft of the off-page content piece
  published_url            text,         -- filled by team after publishing
  published_at             timestamptz,

  -- Metadata
  serp_data                jsonb,        -- raw PAA + related searches stored for reference
  crawl_data               jsonb,        -- page crawl summary
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ── Trigger: auto-update updated_at ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER seo_content_briefs_updated_at
  BEFORE UPDATE ON seo_content_briefs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_seo_content_briefs_site_type
  ON seo_content_briefs (site_url, brief_type);

CREATE INDEX IF NOT EXISTS idx_seo_content_briefs_action_item
  ON seo_content_briefs (action_item_id);

CREATE INDEX IF NOT EXISTS idx_seo_content_briefs_status
  ON seo_content_briefs (status);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE seo_content_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own briefs"
  ON seo_content_briefs FOR SELECT
  USING (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users insert own briefs"
  ON seo_content_briefs FOR INSERT
  WITH CHECK (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users update own briefs"
  ON seo_content_briefs FOR UPDATE
  USING (
    site_url IN (
      SELECT site_url FROM gsc_connections WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access to briefs"
  ON seo_content_briefs
  USING (auth.role() = 'service_role');
