-- ── Saga clustering as authoritative source ──────────────────────────────
-- Extends existing `keyword_maps` to support 2-level hierarchy:
--   level 0: brand (e.g. "World of Warcraft")
--   level 1: sub-product (e.g. "WoW Gold", parent = "World of Warcraft")
-- Keywords map to LEAF (level 1) maps via existing `keyword_map_clusters`.
--
-- Plus adds `cluster_pages` for explicit cluster ↔ page_url mapping
-- (powers cluster authority tracking).
--
-- Auto-migrates existing data:
--  - Tag existing keyword_maps as level=0 (brand) with auto_generated=false
--  - site_slug backfilled to 'g2g' (legacy)
--  - Saga cron (build later) will create level=1 sub-products.

ALTER TABLE public.keyword_maps
  ADD COLUMN IF NOT EXISTS site_slug      text NOT NULL DEFAULT 'g2g',
  ADD COLUMN IF NOT EXISTS parent_map_id  uuid REFERENCES public.keyword_maps(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS level          int  NOT NULL DEFAULT 0
                          CHECK (level IN (0, 1)),
  ADD COLUMN IF NOT EXISTS auto_generated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS description    text,
  ADD COLUMN IF NOT EXISTS source         text NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('manual','saga','tracked_product','keyword_gap'));

-- Existing rows have no parent → level 0 (brand). Backfill explicit.
UPDATE public.keyword_maps SET level = 0 WHERE parent_map_id IS NULL AND level IS DISTINCT FROM 0;

-- Drop old uniqueness constraint that didn't include parent — we want
-- (parent_map_id, topic_slug) unique so "WoW Gold" can be a sub-product
-- under "World of Warcraft" but ALSO an alias of unrelated brand later.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'keyword_maps_owner_user_id_topic_slug_key'
  ) THEN
    ALTER TABLE public.keyword_maps DROP CONSTRAINT keyword_maps_owner_user_id_topic_slug_key;
  END IF;
END $$;

-- New uniqueness: per (owner, site, parent, slug). NULL parent_map_id treated
-- as distinct from non-NULL via Postgres default behaviour, so brand-level
-- "World of Warcraft" can coexist with sub-product "World of Warcraft" under
-- a different parent (rare, but legal).
CREATE UNIQUE INDEX IF NOT EXISTS keyword_maps_unique_per_parent
  ON public.keyword_maps (owner_user_id, site_slug, COALESCE(parent_map_id, '00000000-0000-0000-0000-000000000000'::uuid), topic_slug);

-- Site-scoped lookups
CREATE INDEX IF NOT EXISTS keyword_maps_site_level_idx
  ON public.keyword_maps (owner_user_id, site_slug, level, parent_map_id);

-- ── cluster_pages — explicit page↔cluster mapping ──────────────────────────
-- A page can target multiple clusters (e.g. /categories/wow-gold targets
-- "WoW Gold" sub-product cluster + parent "World of Warcraft" brand).
-- Role distinguishes pillar from spoke from category-page.

CREATE TABLE IF NOT EXISTS public.cluster_pages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id      uuid NOT NULL REFERENCES public.keyword_maps(id) ON DELETE CASCADE,
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  page_url        text NOT NULL,
  role            text NOT NULL DEFAULT 'spoke'
                  CHECK (role IN ('pillar','spoke','category')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cluster_id, page_url)
);

CREATE INDEX IF NOT EXISTS cluster_pages_cluster_idx
  ON public.cluster_pages (cluster_id);

CREATE INDEX IF NOT EXISTS cluster_pages_owner_site_idx
  ON public.cluster_pages (owner_user_id, site_slug);

ALTER TABLE public.cluster_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own cluster_pages"
  ON public.cluster_pages FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- ── Backfill from tracked_products ────────────────────────────────────────
-- Tracked products = manually-curated brand+sub-product entities. Auto-create
-- level-0 brand cluster + level-1 sub-product cluster from each tracked
-- product so existing data isn't lost on first Saga run. Best-effort: name
-- inferred from product.name.

-- Step 1: brand clusters from distinct first-word of tracked_products.name
-- Heuristic: "WoW Gold" → brand "WoW"; "League of Legends Accounts" → brand "League of Legends"
-- We use the simple "first word" rule for the migration; Saga's cron later
-- refines via Sonnet.
INSERT INTO public.keyword_maps (
  owner_user_id, site_slug, topic, topic_slug, level, parent_map_id,
  auto_generated, source, description
)
SELECT DISTINCT
  tp.owner_user_id,
  tp.site_slug,
  split_part(tp.name, ' ', 1) AS topic,
  lower(regexp_replace(split_part(tp.name, ' ', 1), '[^a-z0-9]+', '-', 'gi')) AS topic_slug,
  0 AS level,
  NULL::uuid AS parent_map_id,
  true AS auto_generated,
  'tracked_product' AS source,
  'Auto-seeded from tracked_products. Re-run Saga to refine.' AS description
FROM public.tracked_products tp
WHERE tp.active = true
  AND length(split_part(tp.name, ' ', 1)) > 1
ON CONFLICT DO NOTHING;

-- Step 2: sub-product clusters — one per tracked_product, parent = brand cluster
INSERT INTO public.keyword_maps (
  owner_user_id, site_slug, topic, topic_slug, level, parent_map_id,
  auto_generated, source, description
)
SELECT
  tp.owner_user_id,
  tp.site_slug,
  tp.name AS topic,
  lower(regexp_replace(tp.name, '[^a-z0-9]+', '-', 'gi')) AS topic_slug,
  1 AS level,
  brand_map.id AS parent_map_id,
  true,
  'tracked_product',
  'Auto-seeded from tracked_products. Re-run Saga to refine.'
FROM public.tracked_products tp
JOIN public.keyword_maps brand_map
  ON brand_map.owner_user_id = tp.owner_user_id
  AND brand_map.site_slug = tp.site_slug
  AND brand_map.level = 0
  AND brand_map.topic_slug = lower(regexp_replace(split_part(tp.name, ' ', 1), '[^a-z0-9]+', '-', 'gi'))
WHERE tp.active = true
ON CONFLICT DO NOTHING;

-- Step 3: link tracked_product page_url → its sub-product cluster
INSERT INTO public.cluster_pages (cluster_id, owner_user_id, site_slug, page_url, role)
SELECT
  km.id,
  tp.owner_user_id,
  tp.site_slug,
  tp.page_url,
  'category'
FROM public.tracked_products tp
JOIN public.keyword_maps km
  ON km.owner_user_id = tp.owner_user_id
  AND km.site_slug = tp.site_slug
  AND km.level = 1
  AND km.topic = tp.name
WHERE tp.active = true
ON CONFLICT DO NOTHING;

-- Step 4: copy keywords from tracked_products.keywords[] into keyword_map_clusters
INSERT INTO public.keyword_map_clusters (
  map_id, owner_user_id, keyword, source, source_ref_id
)
SELECT
  km.id,
  tp.owner_user_id,
  unnest(tp.keywords) AS keyword,
  'tracked_product',
  tp.id::text
FROM public.tracked_products tp
JOIN public.keyword_maps km
  ON km.owner_user_id = tp.owner_user_id
  AND km.level = 1
  AND km.topic = tp.name
WHERE tp.active = true
  AND array_length(tp.keywords, 1) > 0
ON CONFLICT DO NOTHING;
