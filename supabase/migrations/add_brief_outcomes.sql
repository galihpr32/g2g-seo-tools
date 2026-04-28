-- Ranking impact tracker for published SEO content briefs.
-- After a brief is marked published, we snapshot the target page's GSC
-- position at publish time, then again at +30, +60, and +90 days.
-- This closes the outcome loop: did the content actually move rankings?

create table if not exists brief_outcomes (
  id              uuid primary key default gen_random_uuid(),
  brief_id        uuid not null references seo_content_briefs(id) on delete cascade,
  owner_user_id   uuid not null,
  page_url        text not null,            -- the page being tracked
  primary_keyword text,                     -- the target keyword

  -- Snapshot data at each checkpoint
  published_at        date,                 -- when brief was marked published
  snapshot_0_at       timestamptz,          -- publish snapshot date
  snapshot_30_at      timestamptz,          -- +30d snapshot date
  snapshot_60_at      timestamptz,          -- +60d snapshot date
  snapshot_90_at      timestamptz,          -- +90d snapshot date

  -- GSC metrics at each checkpoint (null = not yet taken)
  pos_0           numeric(6,2),             -- position at publish
  pos_30          numeric(6,2),
  pos_60          numeric(6,2),
  pos_90          numeric(6,2),

  clicks_0        int,
  clicks_30       int,
  clicks_60       int,
  clicks_90       int,

  impressions_0   int,
  impressions_30  int,
  impressions_60  int,
  impressions_90  int,

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- One outcome row per brief
create unique index if not exists brief_outcomes_brief_id_idx
  on brief_outcomes (brief_id);

create index if not exists brief_outcomes_owner_idx
  on brief_outcomes (owner_user_id, published_at desc);

-- Trigger: auto-update updated_at
create or replace function set_brief_outcomes_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists brief_outcomes_updated_at on brief_outcomes;
create trigger brief_outcomes_updated_at
  before update on brief_outcomes
  for each row execute function set_brief_outcomes_updated_at();

-- RLS: users can only see their own outcomes
alter table brief_outcomes enable row level security;

create policy "brief_outcomes_owner" on brief_outcomes
  using (owner_user_id = auth.uid());
