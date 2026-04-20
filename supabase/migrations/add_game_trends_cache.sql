-- ── game_trends_cache ─────────────────────────────────────────────────────────
-- Caches trending game data from Steam + DataForSEO + SEMrush.
-- TTL: 24 hours (app refreshes stale rows on demand).

CREATE TABLE IF NOT EXISTS public.game_trends_cache (
  steam_appid        integer      PRIMARY KEY,
  name               text         NOT NULL,
  developer          text,
  genre              text,
  -- Steam stats
  players_2weeks     integer      DEFAULT 0,
  players_forever    integer      DEFAULT 0,
  avg_playtime_2w    integer      DEFAULT 0,   -- minutes
  -- Search data (DataForSEO)
  search_volume      integer      DEFAULT 0,
  search_trend       jsonb,                    -- [{date, value}] interest over time (0-100)
  buy_search_volume  integer      DEFAULT 0,   -- "[game] buy" keyword volume
  -- G2G relevance
  g2g_recommended    boolean      DEFAULT false,
  g2g_position       integer,                  -- SEMrush position for main keyword, null if not ranking
  -- Meta
  cached_at          timestamptz  DEFAULT now()
);

ALTER TABLE public.game_trends_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read game_trends_cache"
  ON public.game_trends_cache FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can upsert game_trends_cache"
  ON public.game_trends_cache FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update game_trends_cache"
  ON public.game_trends_cache FOR UPDATE TO authenticated USING (true);

-- Index for freshness checks
CREATE INDEX IF NOT EXISTS game_trends_cache_cached_at
  ON public.game_trends_cache (cached_at DESC);
