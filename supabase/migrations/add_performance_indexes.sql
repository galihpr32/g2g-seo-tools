-- ── Performance Indexes ───────────────────────────────────────────────────────
-- Run this once in Supabase SQL Editor to speed up the most common queries.

-- seo_action_items — most queried table (ranking drop, action items, team perf)
create index if not exists seo_action_items_site_url_idx
  on public.seo_action_items (site_url);

create index if not exists seo_action_items_site_status_idx
  on public.seo_action_items (site_url, status);

create index if not exists seo_action_items_assigned_to_idx
  on public.seo_action_items (assigned_to)
  where assigned_to is not null;

create index if not exists seo_action_items_snapshot_date_idx
  on public.seo_action_items (snapshot_date desc);

create index if not exists seo_action_items_created_at_idx
  on public.seo_action_items (created_at desc);

-- seo_content_briefs — queried per action item and per site
create index if not exists seo_content_briefs_site_url_idx
  on public.seo_content_briefs (site_url);

create index if not exists seo_content_briefs_action_item_idx
  on public.seo_content_briefs (action_item_id);

create index if not exists seo_content_briefs_status_idx
  on public.seo_content_briefs (status);

-- paid_backlinks — queried by owner + status + date
create index if not exists paid_backlinks_owner_status_idx
  on public.paid_backlinks (owner_user_id, link_status);

create index if not exists paid_backlinks_live_date_idx
  on public.paid_backlinks (live_date desc)
  where live_date is not null;

-- tracked_products — queried by owner + active flag
create index if not exists tracked_products_owner_active_idx
  on public.tracked_products (owner_user_id, active);

-- workspace_members — queried heavily for every page load (getEffectiveOwnerId)
create index if not exists workspace_members_member_user_id_idx
  on public.workspace_members (member_user_id)
  where member_user_id is not null;

create index if not exists workspace_members_member_email_idx
  on public.workspace_members (member_email)
  where member_email is not null;

create index if not exists workspace_members_owner_status_idx
  on public.workspace_members (owner_user_id, status);

-- gsc_connections — fetched on nearly every page
create index if not exists gsc_connections_user_id_idx
  on public.gsc_connections (user_id);

-- notifications (if table exists)
create index if not exists notifications_user_id_read_idx
  on public.notifications (user_id, read)
  where read = false;

-- game_trends_cache — queried by slug/game for trend lookups
create index if not exists game_trends_cache_created_at_idx
  on public.game_trends_cache (created_at desc);
