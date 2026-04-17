-- ============================================================
-- Campaign Mode
-- Campaigns group pages into tracked initiatives.
-- Pages can belong to multiple campaigns.
-- Campaigns support hierarchy (parent/child).
-- ============================================================

-- ── campaigns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  gsc_site_url       text,
  parent_campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  color              text NOT NULL DEFAULT '#6366f1',
  position           int  NOT NULL DEFAULT 0,
  -- Flexible goals: { traffic_goal, traffic_period, ranking_goal, ranking_keywords, brief_completion_target, custom }
  goals              jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz DEFAULT now() NOT NULL,
  updated_at         timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_campaigns_owner
  ON campaigns (owner_user_id, position);

CREATE INDEX IF NOT EXISTS idx_campaigns_parent
  ON campaigns (parent_campaign_id);

-- ── campaign_pages ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_pages (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_url         text NOT NULL,
  action_item_id   uuid REFERENCES seo_action_items(id) ON DELETE SET NULL,
  position         int  NOT NULL DEFAULT 0,
  created_at       timestamptz DEFAULT now() NOT NULL,
  UNIQUE (campaign_id, page_url)
);

CREATE INDEX IF NOT EXISTS idx_campaign_pages_campaign
  ON campaign_pages (campaign_id, position);

CREATE INDEX IF NOT EXISTS idx_campaign_pages_owner
  ON campaign_pages (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_campaign_pages_action_item
  ON campaign_pages (action_item_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE campaigns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_pages ENABLE ROW LEVEL SECURITY;

-- Campaigns: owner full access
CREATE POLICY "campaigns: owner full access"
  ON campaigns FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- Campaign pages: owner full access
CREATE POLICY "campaign_pages: owner full access"
  ON campaign_pages FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaigns_updated_at ON campaigns;
CREATE TRIGGER campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
