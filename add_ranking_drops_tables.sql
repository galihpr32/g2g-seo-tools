-- Run this in Supabase SQL Editor
-- Stores detected ranking drops daily so the page reads from DB (no live API call needed)

create table if not exists gsc_ranking_drops (
  id            uuid primary key default gen_random_uuid(),
  site_url      text not null,
  snapshot_date date not null,
  page          text not null,
  clicks_now    int  default 0,
  clicks_prev   int  default 0,
  clicks_drop   numeric(5,4) default 0,   -- e.g. 0.23 = 23% drop
  impressions_now  int default 0,
  impressions_prev int default 0,
  impressions_drop numeric(5,4) default 0,
  position_now  numeric(6,2) default 0,
  position_prev numeric(6,2) default 0,
  position_diff numeric(6,2) default 0,
  created_at    timestamptz default now(),
  unique(site_url, snapshot_date, page)
);

create table if not exists gsc_ranking_drop_queries (
  id            uuid primary key default gen_random_uuid(),
  site_url      text not null,
  snapshot_date date not null,
  page          text not null,
  query         text not null,
  clicks        int  default 0,
  impressions   int  default 0,
  ctr           numeric(6,4) default 0,
  position      numeric(6,2) default 0,
  created_at    timestamptz default now(),
  unique(site_url, snapshot_date, page, query)
);

-- RLS: users can only read data for their own connected sites
alter table gsc_ranking_drops enable row level security;
alter table gsc_ranking_drop_queries enable row level security;

create policy "Users read their own ranking drops"
  on gsc_ranking_drops for select
  using (
    site_url in (
      select site_url from gsc_connections where user_id = auth.uid()
    )
  );

create policy "Users read their own drop queries"
  on gsc_ranking_drop_queries for select
  using (
    site_url in (
      select site_url from gsc_connections where user_id = auth.uid()
    )
  );

-- Service role can insert (used by cron)
create policy "Service role inserts ranking drops"
  on gsc_ranking_drops for insert
  with check (true);

create policy "Service role inserts drop queries"
  on gsc_ranking_drop_queries for insert
  with check (true);

-- Index for fast lookups by date
create index if not exists idx_ranking_drops_date on gsc_ranking_drops(site_url, snapshot_date desc);
create index if not exists idx_drop_queries_page on gsc_ranking_drop_queries(site_url, snapshot_date, page);
