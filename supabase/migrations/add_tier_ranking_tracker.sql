-- ── Keyword Ranking Tracker for Tier 1/2 products ────────────────────────────
-- Built on top of product_tiers. Each tiered product has a manual list of
-- keywords; we snapshot SERP weekly across 5 markets (US, DE, FR, MY, ID)
-- and daily-check for alert-worthy drops (Tier 1 ≥3 pos, Tier 2 fall out top 10).
--
-- Data flow:
--   tier_keywords            ← user adds main + 5-10 secondary per product
--   tier_serp_snapshots      ← weekly DataForSEO snapshot per keyword per market
--   /priority-products/[id]  ← dedicated detail page reading both
--   /api/cron/tier-serp-weekly  ← refreshes snapshots
--   /api/cron/tier-rank-alerts  ← consolidated Slack alert (T1 + T2, both brands)
--
-- GSC data continues to live in gsc_ranking_drops (existing, daily) — that
-- table is the "baseline" lane shown side-by-side with DataForSEO on the page.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Per-product keyword list (manual sourcing)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tier_keywords (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_tier_id   uuid NOT NULL REFERENCES public.product_tiers(id) ON DELETE CASCADE,
  keyword           text NOT NULL,
  /** is_main=true → primary keyword tracked across all markets. Only one per
   *  product. Secondary keywords are also tracked but visualised differently
   *  in the leaderboard. */
  is_main           boolean NOT NULL DEFAULT false,
  /** Display order (1-based, set by UI drag-or-add) so the leaderboard is
   *  consistent across reloads. */
  position          smallint NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.tier_keywords ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own tier keywords"
  ON public.tier_keywords FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- One canonical keyword per product (case-insensitive). UI also enforces, but
-- this is the DB-level guard against duplicate inserts.
CREATE UNIQUE INDEX IF NOT EXISTS tier_keywords_unique_per_product
  ON public.tier_keywords (owner_user_id, product_tier_id, lower(keyword));

-- Per-product listing is the dominant read pattern (detail page render).
CREATE INDEX IF NOT EXISTS tier_keywords_product_idx
  ON public.tier_keywords (owner_user_id, product_tier_id, position);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. SERP snapshots (weekly DataForSEO captures)
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tier_serp_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  product_tier_id   uuid NOT NULL REFERENCES public.product_tiers(id) ON DELETE CASCADE,
  tier_keyword_id   uuid REFERENCES public.tier_keywords(id) ON DELETE SET NULL,
  keyword           text NOT NULL,
  /** ISO 2-letter market code: 'us' | 'de' | 'fr' | 'my' | 'id'.
   *  Stored lowercase so query filters are case-stable. */
  market            text NOT NULL,
  snapshot_date     date NOT NULL,
  /** Our position in the SERP top-100 for this keyword+market. NULL when our
   *  domain doesn't rank in the captured depth. */
  our_position      smallint,
  /** The exact URL of ours that ranks. NULL when no rank. */
  our_url           text,
  /** Top 10 organic results captured. JSONB array of
   *  { position: int, url: string, domain: string, title: string }. Lets the
   *  detail page render the competitor SERP map without re-calling DataForSEO. */
  top_10            jsonb NOT NULL DEFAULT '[]',
  /** Total result count returned (debugging — sometimes DataForSEO returns 0
   *  for blocked queries). */
  total_results     int,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, product_tier_id, keyword, market, snapshot_date)
);

ALTER TABLE public.tier_serp_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own tier serp snapshots"
  ON public.tier_serp_snapshots FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- Dominant read pattern: "latest snapshot per (product, keyword, market)" —
-- used by detail page + alerts cron.
CREATE INDEX IF NOT EXISTS tier_serp_latest_idx
  ON public.tier_serp_snapshots (owner_user_id, product_tier_id, snapshot_date DESC);

-- Per-keyword time series chart on detail page.
CREATE INDEX IF NOT EXISTS tier_serp_kw_history_idx
  ON public.tier_serp_snapshots (owner_user_id, tier_keyword_id, market, snapshot_date DESC);

-- Alerts cron: scan today's snapshots vs prior week's.
CREATE INDEX IF NOT EXISTS tier_serp_date_idx
  ON public.tier_serp_snapshots (snapshot_date DESC, owner_user_id);

COMMENT ON TABLE public.tier_keywords IS
  'Per-Tier-1/2-product manual keyword list. Main + 5-10 secondary keywords.';
COMMENT ON TABLE public.tier_serp_snapshots IS
  'Weekly DataForSEO SERP snapshots per keyword per market. Stores our position + top-10 for competitor visibility.';
