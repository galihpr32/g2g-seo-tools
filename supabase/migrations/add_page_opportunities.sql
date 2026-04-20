-- ── Page Opportunities ────────────────────────────────────────────────────────
-- Stores "genuinely missing page" opportunities discovered via keyword gap analysis.
-- Used to recommend new product/category pages to the product team.

create table if not exists public.page_opportunities (
  id                uuid primary key default gen_random_uuid(),
  owner_user_id     uuid not null references auth.users(id) on delete cascade,
  cluster_name      text not null,         -- e.g. "Monopoly Go Free Dice"
  game_category     text,                  -- e.g. "Monopoly Go"
  keywords          text[] not null default '{}',
  avg_volume        integer,               -- average monthly search volume
  total_volume      integer,               -- sum of all keyword volumes
  competitor_domain text,                  -- which competitor surfaced this gap
  status            text not null default 'new'
                      check (status in ('new', 'reviewing', 'approved', 'rejected')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.page_opportunities enable row level security;

create policy "Users manage own page opportunities"
  on public.page_opportunities for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists page_opportunities_owner_idx
  on public.page_opportunities (owner_user_id, status, created_at desc);
