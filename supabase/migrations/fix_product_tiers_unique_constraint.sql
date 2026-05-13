-- ── Replace partial unique index with regular UNIQUE constraint ──────────────
-- The original add_product_tiers.sql migration created a PARTIAL unique index
-- (with `where relation_id is not null`). Postgres requires ON CONFLICT to
-- include the same WHERE clause to target a partial index, but Supabase's
-- .upsert({onConflict: 'cols'}) emits ON CONFLICT (cols) with no WHERE — so
-- the upsert fails with:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Fix: drop the partial index, replace with a regular UNIQUE constraint on
-- the same columns. PostgreSQL's default NULLS DISTINCT semantics mean two
-- rows where relation_id IS NULL are considered distinct (so users can still
-- add multiple tier rows without a relation_id without hitting the
-- constraint). The constraint only catches duplicates when both rows have
-- the same non-null relation_id — which is what we want for the upsert
-- behavior.

DROP INDEX IF EXISTS public.product_tiers_relation_id_unique;

ALTER TABLE public.product_tiers
  DROP CONSTRAINT IF EXISTS product_tiers_relation_id_unique;

ALTER TABLE public.product_tiers
  ADD CONSTRAINT product_tiers_relation_id_unique
  UNIQUE (owner_user_id, site_slug, relation_id);
