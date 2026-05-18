-- Sprint TIER.PER.MARKET — Per-market tier rankings.
--
-- The original schema modeled tier products as 1 row per (owner × site ×
-- product). That works for a single-market business, but G2G/OG run two
-- markets (US + ID) where the bestseller list is structurally different:
--   • US tier-1 might be: Genshin, Honkai, WoW
--   • ID tier-1 might be: Mobile Legends, Free Fire, Genshin
--
-- Galih's choice (2026-05-15): split tier rows per market. Same product
-- can appear in BOTH tier lists when it's a focus in both countries —
-- that's by design, not duplication.
--
-- This migration:
--   1. Adds `market` text column, defaults 'us' so existing 35+ rows
--      retain their current semantics (they were de-facto US tier).
--   2. Drops the old unique index that ignored market.
--   3. Creates a new unique index keyed on (owner, site, market, relation_id)
--      — same product in US AND ID is now allowed, but same (product × market)
--      stays unique to prevent accidental duplicates within one market.
--
-- DMCA / restriction_type stays per-row but Galih's policy is that the
-- flag is product-level (per his confirmation: "DMCA per produk aja").
-- The admin UI propagates restriction changes to both market rows when
-- they exist — see PUT /api/product-tiers/[id].

ALTER TABLE public.product_tiers
  ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'us'
    CHECK (market IN ('us', 'id'));

-- Drop the old unique index (created in earlier migrations). The original
-- conflict key was (owner_user_id, site_slug, relation_id). We need to
-- replace it with one that includes market so the same product can be
-- tiered in both markets.
DROP INDEX IF EXISTS product_tiers_owner_site_relation_uniq;

-- The upsert in src/app/api/product-tiers/route.ts uses onConflict on
-- (owner_user_id, site_slug, relation_id) — postgres needs this exact set
-- to be UNIQUE. We expand to include market.
CREATE UNIQUE INDEX IF NOT EXISTS product_tiers_owner_site_market_relation_uniq
  ON public.product_tiers (owner_user_id, site_slug, market, relation_id)
  WHERE relation_id IS NOT NULL;

-- Indexed lookups: rankings + tier admin frequently filter by market.
CREATE INDEX IF NOT EXISTS product_tiers_market_idx
  ON public.product_tiers (market);

COMMENT ON COLUMN public.product_tiers.market IS
  'Sprint TIER.PER.MARKET — target market for this tier row. Same product can have separate rows for us + id when it''s a focus in both. NOT to be confused with the keyword-language column on tier_keywords (which controls SERP fetch market) — both should generally align but are stored independently.';
