-- ── Drop obsolete product_tiers_relation_id_unique constraint ────────────────
--
-- BACKGROUND
--   1. add_product_tiers.sql               created partial unique index named
--                                          product_tiers_relation_id_unique
--   2. fix_product_tiers_unique_constraint.sql  dropped the partial index +
--                                          replaced with a regular CONSTRAINT
--                                          (same name) on (owner, site, relation_id)
--   3. add_market_to_product_tiers.sql     introduced 'market' column + a new
--                                          unique index keyed on
--                                          (owner, site, market, relation_id)
--                                          → but it dropped the index named
--                                          product_tiers_owner_site_relation_uniq
--                                          NOT the CONSTRAINT
--                                          product_tiers_relation_id_unique.
--
-- SYMPTOM (caught 2026-05-19 in production by Galih's team adding "Pokemon Go
-- Top Up" for ID market):
--
--   Save failed: duplicate key value violates unique constraint
--   "product_tiers_relation_id_unique"
--
-- The old constraint still enforces uniqueness on (owner, site, relation_id),
-- which contradicts the per-market design where the same product CAN have
-- both a 'us' and an 'id' row.
--
-- FIX
--   Drop the obsolete constraint. The new index
--   product_tiers_owner_site_market_relation_uniq remains and continues to
--   enforce per-(market) uniqueness.

ALTER TABLE public.product_tiers
  DROP CONSTRAINT IF EXISTS product_tiers_relation_id_unique;

-- Also drop the constraint's auto-created backing index if it lingers under
-- the same name (Postgres reuses the name for the index that backs the
-- constraint, so the DROP CONSTRAINT above usually handles this — but on some
-- supabase environments we've seen detached indexes survive).
DROP INDEX IF EXISTS public.product_tiers_relation_id_unique;

-- Verify post-migration:
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.product_tiers'::regclass;
--
-- Expected: product_tiers_owner_site_market_relation_uniq is the only unique
-- constraint mentioning relation_id.
