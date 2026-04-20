-- ── Competitive Analysis Tables ───────────────────────────────────────────────

-- ── 1. Competitors list ──────────────────────────────────────────────────────
-- User-managed list of competitor domains to track.
create table if not exists public.competitors (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  domain          text not null,        -- e.g. "playerauctions.com"
  name            text not null,        -- e.g. "PlayerAuctions"
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_user_id, domain)
);

alter table public.competitors enable row level security;

create policy "Users manage own competitors"
  on public.competitors for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists competitors_owner_idx
  on public.competitors (owner_user_id, active);


-- ── 2. SERP snapshots ────────────────────────────────────────────────────────
-- Stores daily SERP result snapshots per keyword for SoV calculation.
-- results: [{domain, position, url, title}]
create table if not exists public.serp_snapshots (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  keyword         text not null,
  location_code   integer not null default 2840,   -- US default
  language_code   text not null default 'en',
  snapshot_date   date not null default current_date,
  search_volume   integer,
  results         jsonb not null default '[]',      -- top 10 SERP results
  created_at      timestamptz not null default now(),
  unique (owner_user_id, keyword, location_code, snapshot_date)
);

alter table public.serp_snapshots enable row level security;

create policy "Users manage own serp snapshots"
  on public.serp_snapshots for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists serp_snapshots_owner_date_idx
  on public.serp_snapshots (owner_user_id, snapshot_date desc);

create index if not exists serp_snapshots_keyword_idx
  on public.serp_snapshots (owner_user_id, keyword, location_code);
