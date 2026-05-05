-- ── Bifrost: gaming news listener ────────────────────────────────────────────
-- Bifrost (Norse messenger bridge) listens to gaming news RSS feeds and
-- surfaces "buzz" signals about specific games BEFORE they show up in
-- Steam concurrency or DataForSEO trends — earlier than Odin can.
--
-- Tables:
--   news_sources           — configured RSS feeds (5 starter sites + user-extensible)
--   news_items             — raw RSS entries (deduped by url)
--   news_game_extractions  — Haiku-extracted game mentions per article
--   bifrost_runs           — audit log per cron run (similar to agent_runs)
--
-- Pipeline flow:
--   RSS sources --[/api/cron/bifrost]--> news_items + news_game_extractions
--                                  --[threshold ≥3 articles + KB match]--> agent_actions
--                                  --[Saga aggregator]--> seo_opportunities
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.news_sources (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text         NOT NULL,                          -- 'IGN', 'Polygon', etc.
  rss_url         text         NOT NULL,                          -- RSS/Atom feed URL
  homepage_url    text,                                            -- for FireCrawl deep dive fallback
  category        text         DEFAULT 'general',                  -- general | mobile | esports | publisher
  is_active       boolean      NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_item_count integer      DEFAULT 0,
  notes           text,
  created_at      timestamptz  DEFAULT now(),
  updated_at      timestamptz  DEFAULT now(),
  UNIQUE (owner_user_id, rss_url)
);

CREATE INDEX IF NOT EXISTS news_sources_owner_active
  ON public.news_sources (owner_user_id, is_active);

ALTER TABLE public.news_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner can manage news sources"
  ON public.news_sources FOR ALL TO authenticated
  USING (owner_user_id = auth.uid() OR owner_user_id IN (
    SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
  ))
  WITH CHECK (owner_user_id = auth.uid() OR owner_user_id IN (
    SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
  ));


-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.news_items (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source_id       uuid         REFERENCES public.news_sources(id) ON DELETE SET NULL,
  source_name     text,                                            -- denormalised for display speed
  url             text         NOT NULL,                            -- canonical article URL
  title           text         NOT NULL,
  excerpt         text,                                            -- RSS description / first 500 chars
  published_at    timestamptz,
  fetched_at      timestamptz  NOT NULL DEFAULT now(),
  -- FireCrawl deep-dive output (manual trigger from UI; null until fetched)
  scraped_md         text,
  scraped_at         timestamptz,
  scraped_word_count integer,
  -- Haiku extraction status
  extraction_status  text       NOT NULL DEFAULT 'pending',   -- pending | done | failed | skipped
  extraction_error   text,

  UNIQUE (owner_user_id, url)
);

CREATE INDEX IF NOT EXISTS news_items_owner_published
  ON public.news_items (owner_user_id, published_at DESC);

CREATE INDEX IF NOT EXISTS news_items_extraction_status
  ON public.news_items (owner_user_id, extraction_status)
  WHERE extraction_status = 'pending';

ALTER TABLE public.news_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner can read news items"
  ON public.news_items FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid() OR owner_user_id IN (
    SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
  ));


-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.news_game_extractions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  news_item_id    uuid         NOT NULL REFERENCES public.news_items(id) ON DELETE CASCADE,
  game_name       text         NOT NULL,                            -- as extracted by Haiku
  game_name_norm  text         NOT NULL,                            -- lower-cased + slug for matching
  news_type       text,                                              -- release | event | update | esports | leak | review | sale | other
  mentions_count  integer      DEFAULT 1,                           -- mention count within the article
  kb_matched      boolean      DEFAULT false,                       -- matched a KB category/game?
  kb_category_id  uuid,                                              -- knowledge_base_items.id when matched

  created_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (news_item_id, game_name_norm)
);

CREATE INDEX IF NOT EXISTS news_game_extractions_owner_game
  ON public.news_game_extractions (owner_user_id, game_name_norm, created_at DESC);

CREATE INDEX IF NOT EXISTS news_game_extractions_owner_kbmatch
  ON public.news_game_extractions (owner_user_id, kb_matched, created_at DESC);

ALTER TABLE public.news_game_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner can read extractions"
  ON public.news_game_extractions FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid() OR owner_user_id IN (
    SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
  ));


-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bifrost_runs (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at           timestamptz  NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  status               text         NOT NULL DEFAULT 'running',   -- running | success | error | partial
  sources_polled       integer      DEFAULT 0,
  items_new            integer      DEFAULT 0,
  items_extracted      integer      DEFAULT 0,
  actions_queued       integer      DEFAULT 0,
  cost_usd             numeric(8,4) DEFAULT 0,
  error_message        text,
  warnings             text[],
  summary              text
);

CREATE INDEX IF NOT EXISTS bifrost_runs_owner_started
  ON public.bifrost_runs (owner_user_id, started_at DESC);

ALTER TABLE public.bifrost_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner can read bifrost runs"
  ON public.bifrost_runs FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid() OR owner_user_id IN (
    SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
  ));


-- ─────────────────────────────────────────────────────────────────────────────
-- Tier 1 default sources — seeded per-workspace by /api/cron/bifrost on first run.
-- Hardcoded URLs (subject to feed changes by the publishers):
--   IGN       https://feeds.ign.com/ign/games-all
--   Polygon   https://www.polygon.com/rss/index.xml
--   PC Gamer  https://www.pcgamer.com/rss/
--   Eurogamer https://www.eurogamer.net/?format=rss
--   GameRant  https://gamerant.com/feed/
-- (Insertion is a no-op via ON CONFLICT for the (owner_user_id, rss_url) unique key.)
-- The cron route handles seeding; this migration only declares the schema.
