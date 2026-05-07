-- ── Daily Keyword Ranking History ─────────────────────────────────────────────
-- Up to now `tracked_products` stored a list of (product, [keywords]) but
-- nothing actually fetched daily SERP positions for those keywords. The
-- product-rankings page even said "Daily position checks coming soon" 😅.
--
-- This migration:
--   1. Adds site_slug to tracked_products so OffGamers products are isolated
--      from G2G ones (and the cron only tracks the active site's products).
--   2. Creates keyword_ranking_history — one row per
--      (tracked_product, keyword, country_code, snapshot_date) — populated
--      daily by /api/cron/keyword-rankings.
--
-- The `position` column is nullable: when the keyword doesn't appear in the
-- top N organic results we still write a row with position=NULL so the UI can
-- distinguish "we checked and you weren't ranking" from "we never checked".

-- ── 1. site_slug on tracked_products ──────────────────────────────────────────
ALTER TABLE public.tracked_products
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS tracked_products_site_slug_idx
  ON public.tracked_products (site_slug, active);

-- Backfill: existing rows are all G2G (OG hadn't onboarded any products yet)
UPDATE public.tracked_products SET site_slug = 'g2g' WHERE site_slug IS NULL;

-- ── 2. keyword_ranking_history table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.keyword_ranking_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug           text NOT NULL DEFAULT 'g2g',
  tracked_product_id  uuid NOT NULL REFERENCES public.tracked_products(id) ON DELETE CASCADE,
  keyword             text NOT NULL,
  country_code        text NOT NULL,                -- iso2 lowercase, e.g. 'us','id'
  snapshot_date       date NOT NULL,
  position            int,                          -- 1..100, null if not in top N
  url                 text,                         -- the ranking URL on our domain (null if not ranked)
  search_volume       int,                          -- captured at fetch time so historical reports still work
  serp_features       jsonb,                        -- optional metadata: {has_paa: true, has_video: false, ...}
  raw                 jsonb,                        -- raw DFS organic_result row for debug
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Idempotent upserts: re-running the cron same day overwrites that snapshot
CREATE UNIQUE INDEX IF NOT EXISTS keyword_ranking_history_unique_idx
  ON public.keyword_ranking_history (tracked_product_id, keyword, country_code, snapshot_date);

-- Hot-path queries: "show me last 30 days of rankings for product X"
CREATE INDEX IF NOT EXISTS keyword_ranking_history_product_date_idx
  ON public.keyword_ranking_history (tracked_product_id, snapshot_date DESC);

-- "Show me everything I tracked on day Y for site Z" (cron monitoring)
CREATE INDEX IF NOT EXISTS keyword_ranking_history_owner_date_idx
  ON public.keyword_ranking_history (owner_user_id, site_slug, snapshot_date DESC);

ALTER TABLE public.keyword_ranking_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own keyword ranking history"
  ON public.keyword_ranking_history FOR SELECT
  USING (auth.uid() = owner_user_id);

-- Cron writes via service role, so no INSERT policy needed for end-users.
