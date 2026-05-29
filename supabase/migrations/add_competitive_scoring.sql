-- Sprint COMPETITIVE.SCORER.1 — Scoring columns on tier_keywords.
--
-- Implements the methodology page formula:
--   score = (SV_norm × 0.50) + (SERP Density × 0.30) + (Intent × 0.20)
--
-- Cluster = priority_product × market (Q1 decision).
-- Per cluster we mark up to top 3 winners (Q2 decision).
--
-- Why on tier_keywords (not a separate scoring table):
--   Each kw has exactly one canonical score at any moment. Re-scoring is a
--   weekly batch that overrides. A separate table would add a join on every
--   read for no real benefit at our scale (≤ ~500 tier_keywords total).
--
-- Why we don't compute score on read:
--   Density needs SERP top-10 inspection (expensive). SV needs DataForSEO call.
--   Both are stable for ~a week. Compute once during the weekly cron + cache.

ALTER TABLE public.tier_keywords
  ADD COLUMN IF NOT EXISTS sv_volume         integer,                       -- raw monthly search volume from DataForSEO
  ADD COLUMN IF NOT EXISTS sv_volume_norm    integer  CHECK (sv_volume_norm  IS NULL OR sv_volume_norm  BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS serp_density      integer  CHECK (serp_density    IS NULL OR serp_density    BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS intent_score      integer  CHECK (intent_score    IS NULL OR intent_score    BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS competitive_score integer  CHECK (competitive_score IS NULL OR competitive_score BETWEEN 0 AND 100),
  -- Sprint COMPETITIVE.SCORER — cluster bookkeeping.
  -- cluster_market: the market this kw competes in (mirrors product_tiers.market
  -- usually but kept here to let one kw potentially compete in different markets
  -- in future without re-keying). Today defaults to product_tier.market.
  ADD COLUMN IF NOT EXISTS cluster_market    text,
  -- is_cluster_winner = top 3 by competitive_score within (product_tier × market).
  -- Friday KPI digest "Most Competitive Keyword Rankings" pulls this subset.
  ADD COLUMN IF NOT EXISTS is_cluster_winner boolean  NOT NULL DEFAULT false,
  -- cluster_rank: 1 = top, 2 = second, 3 = third. NULL when not a winner.
  ADD COLUMN IF NOT EXISTS cluster_rank      smallint CHECK (cluster_rank IS NULL OR cluster_rank BETWEEN 1 AND 3),
  ADD COLUMN IF NOT EXISTS last_scored_at    timestamptz;

-- Fast lookup for the "show me winners only" Friday KPI query
CREATE INDEX IF NOT EXISTS tier_keywords_winners_idx
  ON public.tier_keywords (owner_user_id, product_tier_id, cluster_market, cluster_rank)
  WHERE is_cluster_winner = true;

-- Score-ordered query for the discovery flow ("show me top 10 candidates")
CREATE INDEX IF NOT EXISTS tier_keywords_score_idx
  ON public.tier_keywords (owner_user_id, product_tier_id, competitive_score DESC NULLS LAST);

COMMENT ON COLUMN public.tier_keywords.competitive_score IS
  'Methodology blend: 0.50*SV_norm + 0.30*serp_density + 0.20*intent_score. Range 0-100. Higher = more competitive (= more worth chasing).';

COMMENT ON COLUMN public.tier_keywords.is_cluster_winner IS
  'Top 3 by competitive_score within (product_tier_id × cluster_market). Friday KPI digest pulls this subset.';

COMMENT ON COLUMN public.tier_keywords.cluster_market IS
  'Market this kw is scored against. Cluster = (product_tier_id × cluster_market). Per Sprint COMPETITIVE.SCORER design.';
