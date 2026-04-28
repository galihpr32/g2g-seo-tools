-- ============================================================
-- Migration: seo_opportunities
-- Central pipeline entity that groups detection signals
-- (Heimdall/Loki/Odin) by topic so humans can triage and
-- decide what to do with them (brief, outreach, dismiss).
-- ============================================================

create table if not exists public.seo_opportunities (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null,
  site_slug       text not null default 'g2g',

  -- What this opportunity is about
  topic           text not null,
  topic_slug      text not null,        -- kebab-case slug, used as grouping key
  target_url      text,                 -- specific page being monitored (from Heimdall)

  -- Detection signals — JSONB arrays, each entry includes action_id for dedup
  heimdall_signals  jsonb not null default '[]'::jsonb,
  loki_signals      jsonb not null default '[]'::jsonb,
  odin_signals      jsonb not null default '[]'::jsonb,

  -- Aggregated keyword candidates across all signals
  keyword_universe  jsonb not null default '[]'::jsonb,

  -- Pipeline state
  -- 'new' | 'in_review' | 'brief_queued' | 'brief_ready' | 'published' | 'dismissed'
  status          text not null default 'new',

  -- What type of action to take (decided by human during review)
  -- 'new_page' | 'optimize_existing' | 'outreach' | null
  output_type     text,

  -- Downstream linkage
  brief_id        uuid references public.seo_content_briefs(id) on delete set null,

  -- Tyr quality scoring (once brief is generated and reviewed)
  tyr_score       integer,
  tyr_status      text,
  tyr_feedback    jsonb,

  -- Summary metrics (denormalised for fast list rendering)
  signal_count    integer not null default 0,
  total_sv        integer not null default 0,

  -- Optional: link to existing keyword_maps topic if matched
  map_id          uuid references public.keyword_maps(id) on delete set null,

  -- Timestamps
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_signal_at  timestamptz
);

-- One opportunity per topic per site per owner
create unique index if not exists seo_opportunities_owner_site_topic_key
  on public.seo_opportunities (owner_user_id, site_slug, topic_slug);

-- Fast lookups by status
create index if not exists seo_opportunities_owner_status_idx
  on public.seo_opportunities (owner_user_id, status);

-- Fast lookups sorted by recency
create index if not exists seo_opportunities_owner_updated_idx
  on public.seo_opportunities (owner_user_id, updated_at desc);

-- Row Level Security
alter table public.seo_opportunities enable row level security;

create policy "Users manage own opportunities"
  on public.seo_opportunities
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create policy "Service role full access to opportunities"
  on public.seo_opportunities
  for all
  to service_role
  using (true)
  with check (true);
