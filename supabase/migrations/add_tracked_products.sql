-- ── Tracked Products ──────────────────────────────────────────────────────────
-- Stores the list of top products/pages to monitor daily for keyword positions.
-- Used by the Product Rankings page + future DataForSEO position checks.

create table if not exists public.tracked_products (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  name            text not null,
  page_url        text not null,
  keywords        text[] not null default '{}',
  market          text not null default 'us',
  active          boolean not null default true,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.tracked_products enable row level security;

create policy "Users manage own tracked products"
  on public.tracked_products for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Index for fast per-user queries
create index if not exists tracked_products_owner_idx
  on public.tracked_products (owner_user_id, active);
