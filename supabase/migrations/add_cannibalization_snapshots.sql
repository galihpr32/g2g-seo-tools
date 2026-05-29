-- ── Cannibalization snapshots ───────────────────────────────────────────────
-- Weekly cron persists each cannibalisation finding so we can show a
-- timeline ("worsening" / "stable" / "resolved") on the cannibalization
-- detail page.
--
-- Composite key (owner, site, query, snapshot_date) — one row per query
-- per week. severity, total_clicks, page_count, split_score capture the
-- delta dimensions over time.

create table if not exists public.cannibalization_snapshots (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  site_slug       text not null default 'g2g',
  query           text not null,
  snapshot_date   date not null default current_date,
  severity        text not null,                   -- 'critical' | 'warning' | 'info'
  page_count      int  not null,                   -- distinct pages competing
  total_clicks    int  not null default 0,
  total_impressions int not null default 0,
  split_score     numeric(4,2) not null default 0,
  pages           jsonb not null default '[]'::jsonb,  -- pages snapshot for diffing
  recommendation  text,
  created_at      timestamptz not null default now(),
  unique (owner_user_id, site_slug, query, snapshot_date)
);

alter table public.cannibalization_snapshots enable row level security;

create policy "Users manage own cannibalization snapshots"
  on public.cannibalization_snapshots for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists cannib_snapshots_owner_query_idx
  on public.cannibalization_snapshots (owner_user_id, site_slug, query, snapshot_date desc);

create index if not exists cannib_snapshots_site_date_idx
  on public.cannibalization_snapshots (owner_user_id, site_slug, snapshot_date desc);
