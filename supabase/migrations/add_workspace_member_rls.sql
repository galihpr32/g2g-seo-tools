-- ─────────────────────────────────────────────────────────────────────────────
-- Workspace member RLS policies
-- Allows active workspace members to read their workspace owner's data.
-- These are ADDITIVE SELECT policies — they OR with existing policies.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Helper: get effective owner for the current user ─────────────────────────
CREATE OR REPLACE FUNCTION public.get_effective_owner_id(requesting_user uuid DEFAULT auth.uid())
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT owner_user_id
      FROM   workspace_members
      WHERE  member_user_id = requesting_user
        AND  status = 'active'
      LIMIT  1
    ),
    requesting_user
  );
$$;

-- ── Helper: can the current user access data belonging to a given owner? ──────
CREATE OR REPLACE FUNCTION public.can_access_owner_data(owner_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT get_effective_owner_id(auth.uid()) = owner_id;
$$;


-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_members: allow members to read their own record
-- (needed for role checks and the email-based auto-link fallback)
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "workspace_member_self_read" ON workspace_members;
CREATE POLICY "workspace_member_self_read"
  ON workspace_members FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR member_user_id = auth.uid()
    OR member_email = (
      SELECT email FROM auth.users WHERE id = auth.uid()
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- gsc_connections: member can read owner's connection
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "workspace_member_read_gsc_connections" ON gsc_connections;
CREATE POLICY "workspace_member_read_gsc_connections"
  ON gsc_connections FOR SELECT
  USING (can_access_owner_data(user_id));


-- ─────────────────────────────────────────────────────────────────────────────
-- campaigns: member can read owner's campaigns
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "workspace_member_read_campaigns" ON campaigns;
CREATE POLICY "workspace_member_read_campaigns"
  ON campaigns FOR SELECT
  USING (can_access_owner_data(owner_user_id));


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables keyed by site_url — resolve owner via gsc_connections
-- ─────────────────────────────────────────────────────────────────────────────

-- seo_action_items
DROP POLICY IF EXISTS "workspace_member_read_action_items" ON seo_action_items;
CREATE POLICY "workspace_member_read_action_items"
  ON seo_action_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM gsc_connections gc
      WHERE  gc.site_url = seo_action_items.site_url
        AND  can_access_owner_data(gc.user_id)
    )
  );

-- seo_content_briefs
DROP POLICY IF EXISTS "workspace_member_read_content_briefs" ON seo_content_briefs;
CREATE POLICY "workspace_member_read_content_briefs"
  ON seo_content_briefs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM gsc_connections gc
      WHERE  gc.site_url = seo_content_briefs.site_url
        AND  can_access_owner_data(gc.user_id)
    )
  );

-- gsc_ranking_drops
DROP POLICY IF EXISTS "workspace_member_read_ranking_drops" ON gsc_ranking_drops;
CREATE POLICY "workspace_member_read_ranking_drops"
  ON gsc_ranking_drops FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM gsc_connections gc
      WHERE  gc.site_url = gsc_ranking_drops.site_url
        AND  can_access_owner_data(gc.user_id)
    )
  );

-- gsc_daily_stats (if exists)
DROP POLICY IF EXISTS "workspace_member_read_gsc_daily_stats" ON gsc_daily_stats;
CREATE POLICY "workspace_member_read_gsc_daily_stats"
  ON gsc_daily_stats FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM gsc_connections gc
      WHERE  gc.site_url = gsc_daily_stats.site_url
        AND  can_access_owner_data(gc.user_id)
    )
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables keyed by user_id
-- ─────────────────────────────────────────────────────────────────────────────

-- knowledge_base_items
DROP POLICY IF EXISTS "workspace_member_read_kb" ON knowledge_base_items;
CREATE POLICY "workspace_member_read_kb"
  ON knowledge_base_items FOR SELECT
  USING (can_access_owner_data(user_id));

-- notifications
DROP POLICY IF EXISTS "workspace_member_read_notifications" ON notifications;
CREATE POLICY "workspace_member_read_notifications"
  ON notifications FOR SELECT
  USING (can_access_owner_data(user_id));


-- ─────────────────────────────────────────────────────────────────────────────
-- Tables keyed by owner_user_id
-- ─────────────────────────────────────────────────────────────────────────────

-- category_prompts
DROP POLICY IF EXISTS "workspace_member_read_category_prompts" ON category_prompts;
CREATE POLICY "workspace_member_read_category_prompts"
  ON category_prompts FOR SELECT
  USING (can_access_owner_data(owner_user_id));

-- outreach_prospects
DROP POLICY IF EXISTS "workspace_member_read_outreach" ON outreach_prospects;
CREATE POLICY "workspace_member_read_outreach"
  ON outreach_prospects FOR SELECT
  USING (can_access_owner_data(owner_user_id));

-- campaign_pages (if it has owner_user_id)
DROP POLICY IF EXISTS "workspace_member_read_campaign_pages" ON campaign_pages;
CREATE POLICY "workspace_member_read_campaign_pages"
  ON campaign_pages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM campaigns c
      WHERE  c.id = campaign_pages.campaign_id
        AND  can_access_owner_data(c.owner_user_id)
    )
  );
