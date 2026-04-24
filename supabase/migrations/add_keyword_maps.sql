-- ── Keyword Maps ─────────────────────────────────────────────────────────────
-- Topic cluster / keyword mapping hub. One map = one topic (e.g. "Mobile Legends").
-- Clusters are the individual keywords belonging to that topic.

create table if not exists public.keyword_maps (
  id              uuid        primary key default gen_random_uuid(),
  owner_user_id   uuid        not null references auth.users(id) on delete cascade,
  topic           text        not null,           -- "Mobile Legends"
  topic_slug      text        not null,           -- "mobile-legends" (matching key)
  aliases         text[]      not null default '{}', -- ["ML", "MLBB"]
  pillar_keyword  text,
  pillar_title    text,
  pillar_url_slug text,
  market          text        not null default 'us',
  status          text        not null default 'planning', -- planning | in_progress | published
  ai_notes        jsonb,      -- { priority_note, linking_note, estimated_weeks }
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (owner_user_id, topic_slug)
);

create table if not exists public.keyword_map_clusters (
  id              uuid        primary key default gen_random_uuid(),
  map_id          uuid        not null references public.keyword_maps(id) on delete cascade,
  owner_user_id   uuid        not null references auth.users(id) on delete cascade,
  keyword         text        not null,
  search_volume   integer,
  difficulty      integer,    -- 0–100 from DataForSEO bulk difficulty
  intent          text,       -- commercial | informational | transactional | navigational
  content_type    text,       -- landing_page | guide | comparison | faq
  cluster_group   text,       -- sub-topic bucket (e.g. "Price & Currency")
  suggested_title text,
  url_slug        text,
  priority_order  integer     not null default 99,
  is_pillar       boolean     not null default false,
  status          text        not null default 'not_started', -- not_started | writing | review | published | tracking
  source          text        not null default 'manual', -- manual | trends | keyword_gap | loki | odin | hermod
  source_ref_id   text,       -- optional: ID in origin table
  created_at      timestamptz not null default now(),
  unique (map_id, keyword)
);

-- RLS
alter table public.keyword_maps         enable row level security;
alter table public.keyword_map_clusters enable row level security;

create policy "Users manage own keyword maps"
  on public.keyword_maps for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create policy "Users manage own keyword map clusters"
  on public.keyword_map_clusters for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Indexes
create index if not exists keyword_maps_owner_idx
  on public.keyword_maps (owner_user_id, created_at desc);

create index if not exists keyword_map_clusters_map_idx
  on public.keyword_map_clusters (map_id, priority_order);

create index if not exists keyword_map_clusters_owner_idx
  on public.keyword_map_clusters (owner_user_id);
