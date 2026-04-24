-- ── GSC Connections ──────────────────────────────────────────────────────────
-- Stores Google Search Console OAuth tokens and the verified site_url per user.
-- Written by /api/auth/google/callback after OAuth completes.
-- Read by gsc-daily cron, ranking-drop page, action-items, dashboard, etc.

create table if not exists public.gsc_connections (
  user_id       uuid        primary key references auth.users(id) on delete cascade,
  site_url      text        not null default '',
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now()
);

alter table public.gsc_connections enable row level security;

-- Users can only read/write their own connection
create policy "Users manage own gsc connection"
  on public.gsc_connections for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Index already referenced in add_performance_indexes.sql — safe to keep IF NOT EXISTS
create index if not exists gsc_connections_user_id_idx
  on public.gsc_connections (user_id);
