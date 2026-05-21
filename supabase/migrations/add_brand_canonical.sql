-- Sprint CLUSTER.RENAME.1 — fix garbage cluster names from add_saga_cluster_hierarchy.sql
--
-- That migration auto-seeded brand clusters using `split_part(tp.name, ' ', 1)` —
-- just the first word. Result: "Counter Strike: Global Offensive" → "Counter",
-- "World of Warcraft" → "World", "Brawl Stars" → "Brawl", etc.
--
-- This migration adds the schema needed to fix that mess:
--
--   1. product_tiers.brand_canonical — optional user override. When set, it
--      becomes the source of truth for brand cluster name. When NULL, the
--      resolver falls back to g2g_products.service_name (catalog), then to
--      product_tiers.product_name (full, not first-word).
--
--   2. keyword_maps.topic_original — backup of the original topic value before
--      the rename. Lets us preview "before/after" + restore individual rows.

ALTER TABLE public.product_tiers
  ADD COLUMN IF NOT EXISTS brand_canonical TEXT;

COMMENT ON COLUMN public.product_tiers.brand_canonical
  IS 'Sprint CLUSTER.RENAME.1 — optional override for the canonical brand name used in clustering. NULL = auto-resolve from catalog service_name or product_name.';

ALTER TABLE public.keyword_maps
  ADD COLUMN IF NOT EXISTS topic_original TEXT;

COMMENT ON COLUMN public.keyword_maps.topic_original
  IS 'Sprint CLUSTER.RENAME.2 — original topic value captured before the brand-rename re-seed. Lets us restore if a rename was wrong.';

CREATE INDEX IF NOT EXISTS idx_product_tiers_brand_canonical
  ON public.product_tiers (brand_canonical)
  WHERE brand_canonical IS NOT NULL;
