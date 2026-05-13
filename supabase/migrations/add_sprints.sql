-- ── Sprints — sprint_id on briefs + opportunities + action_items ────────────
-- Lets the team filter pipeline by sprint and run sprint-level retros.
-- Sprints are owner+site scoped (each PIC may run own cadence) but shared
-- workspace members see them via existing workspace RLS.

create table if not exists public.sprints (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  site_slug       text not null default 'g2g',
  label           text not null,                          -- "May W1 2026"
  started_at      date not null,
  ended_at        date,                                    -- null = currently active
  goal            text,                                    -- short narrative
  created_at      timestamptz not null default now(),
  unique (owner_user_id, site_slug, label)
);

alter table public.sprints enable row level security;
create policy "Users manage own sprints"
  on public.sprints for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists sprints_owner_site_idx
  on public.sprints (owner_user_id, site_slug, started_at desc);

-- Add sprint_id to the three pipeline-relevant tables.
alter table public.seo_content_briefs add column if not exists sprint_id uuid
  references public.sprints(id) on delete set null;

alter table public.seo_opportunities add column if not exists sprint_id uuid
  references public.sprints(id) on delete set null;

alter table public.seo_action_items add column if not exists sprint_id uuid
  references public.sprints(id) on delete set null;

create index if not exists briefs_sprint_idx       on public.seo_content_briefs(sprint_id) where sprint_id is not null;
create index if not exists opportunities_sprint_idx on public.seo_opportunities(sprint_id) where sprint_id is not null;
create index if not exists action_items_sprint_idx  on public.seo_action_items(sprint_id) where sprint_id is not null;
