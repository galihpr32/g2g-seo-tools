-- ── KB per-site (Task #26) ───────────────────────────────────────────────────
-- knowledge_base_items had owner_user_id + (category, name) uniqueness, which
-- meant G2G and OffGamers shared the KB. Now they each get their own.
--
-- Design decision: 'brand' rows STAY shared per owner (one brand per workspace
-- doesn't change between site contexts). 'category' and 'platform' rows go
-- per-site since each brand has different category trees and platform lists.
-- We model this with a single site_slug column where 'brand' rows can be
-- tagged with the special slug '*' meaning "applies to all sites".

ALTER TABLE public.knowledge_base_items
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

-- Drop the old single-site unique constraint
ALTER TABLE public.knowledge_base_items
  DROP CONSTRAINT IF EXISTS knowledge_base_items_owner_user_id_category_name_key;

-- New constraint: one entry per (owner, site, category, name)
ALTER TABLE public.knowledge_base_items
  ADD CONSTRAINT knowledge_base_items_owner_site_category_name_key
  UNIQUE (owner_user_id, site_slug, category, name);

-- Replace the old index too
DROP INDEX IF EXISTS idx_knowledge_base_owner_category;
CREATE INDEX IF NOT EXISTS idx_knowledge_base_owner_site_category
  ON public.knowledge_base_items (owner_user_id, site_slug, category);
