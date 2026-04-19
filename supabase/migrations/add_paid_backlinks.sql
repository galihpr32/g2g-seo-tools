-- Paid Backlink / Guest Post Tracker
-- Tracks external links pointing back to G2G pages, paid or organic
create table if not exists public.paid_backlinks (
  id                    uuid primary key default gen_random_uuid(),
  owner_user_id         uuid not null references auth.users(id) on delete cascade,

  -- The external site info
  site_name             text not null,          -- e.g. "IGN", "PCGamer blog"
  external_url          text not null,          -- full URL of the page with the link
  anchor_text           text not null,          -- the anchor text used for the link

  -- Our target page
  target_page           text not null,          -- our G2G page being linked to
  target_keyword        text,                   -- the keyword we want to rank for

  -- UTM tracking
  utm_source            text,
  utm_medium            text default 'referral',
  utm_campaign          text,
  utm_term              text,
  utm_content           text,

  -- Link status
  link_status           text not null default 'active' check (link_status in ('active', 'broken', 'pending')),
  last_checked_at       timestamptz,
  check_method          text,                   -- 'fetch' or 'firecrawl'

  -- Ranking history (JSONB array: [{date: "2024-01", position: 12}])
  position_history      jsonb not null default '[]',
  position_current      integer,                -- latest known position
  position_at_creation  integer,                -- position when backlink was added

  -- Cost tracking
  cost_amount           numeric(10,2),
  cost_currency         text default 'USD',

  -- Dates
  live_date             date,                   -- when the link went live
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Indexes
create index if not exists paid_backlinks_owner_idx on public.paid_backlinks(owner_user_id);
create index if not exists paid_backlinks_target_page_idx on public.paid_backlinks(target_page);
create index if not exists paid_backlinks_status_idx on public.paid_backlinks(link_status);

-- RLS
alter table public.paid_backlinks enable row level security;

create policy "Users can manage their own backlinks"
  on public.paid_backlinks
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Updated_at trigger (reuse existing trigger function if it exists, otherwise create)
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger paid_backlinks_updated_at
  before update on public.paid_backlinks
  for each row execute function public.handle_updated_at();
