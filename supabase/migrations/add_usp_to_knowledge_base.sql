-- ── USP support in knowledge_base_items ──────────────────────────────────────
-- Extends the category CHECK constraint to allow 'usp' entries.
-- USP data shape:
--   { description: string, applicable_category_ids: string[] }
--   applicable_category_ids = array of knowledge_base_items.id where category='category'

-- Drop the existing CHECK constraint (auto-named by Postgres)
ALTER TABLE public.knowledge_base_items
  DROP CONSTRAINT IF EXISTS knowledge_base_items_category_check;

-- Re-add with 'usp' included
ALTER TABLE public.knowledge_base_items
  ADD CONSTRAINT knowledge_base_items_category_check
  CHECK (category IN ('brand', 'category', 'platform', 'usp'));
