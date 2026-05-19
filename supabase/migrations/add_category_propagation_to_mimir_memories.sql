-- Sprint MIMIR.NOTES.APPLY.1 — Category-aware pattern propagation.
--
-- Galih's mental model: Phase 1 = manual learning on T1/T2 products. Patterns
-- get codified as mimir_memories. Phase 2 (future) = T0 (mass catalog tier)
-- product creation auto-applies the same patterns, so T0 quality ≈ T1/T2
-- quality. This is the "manual investment becomes reusable asset" architecture.
--
-- To make a memory propagate to category peers, we need:
--   • category text column (denormalized for fast filter — no join required)
--   • apply_to_category boolean flag (explicit user opt-in)
--
-- Default behavior unchanged — memories without apply_to_category=true stay
-- product-scoped (current behavior preserved).

-- NOTE: existing `category` column on mimir_memories means MEMORY category
-- (preference / fact / rule / lesson — what kind of memory this is). To avoid
-- conflict, we add `product_category` for the denormalized parent product's
-- category (Game Coins, Top Up, etc).
ALTER TABLE public.mimir_memories
  ADD COLUMN IF NOT EXISTS product_category text,
  ADD COLUMN IF NOT EXISTS apply_to_category boolean NOT NULL DEFAULT false;

-- Retriever uses this index when looking for "category patterns to apply to
-- this brief". Hot path during brief regeneration.
CREATE INDEX IF NOT EXISTS mimir_memories_category_pattern_idx
  ON public.mimir_memories (owner_user_id, site_slug, product_category)
  WHERE apply_to_category = true AND archived = false;

COMMENT ON COLUMN public.mimir_memories.product_category IS
  'Snapshot of parent product''s product_tiers.category at note creation. Denormalized for fast category-pattern retrieval without join. Separate from existing category column (which holds preference/fact/rule/lesson).';

COMMENT ON COLUMN public.mimir_memories.apply_to_category IS
  'When true, this memory is treated as a category-wide pattern (not just product-specific). Brief regeneration of any product in the same category picks it up. Used for cross-product learning that propagates manual T1/T2 work to future T0 mass content.';

-- Also tag seo_content_briefs with which mimir memories informed this generation,
-- so the brief editor can show trust-signal "X notes from Mimir were applied here"
ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS mimir_notes_applied jsonb;

COMMENT ON COLUMN public.seo_content_briefs.mimir_notes_applied IS
  'Sprint MIMIR.NOTES.APPLY — array of {id, category, scope, content} captured at generate-time. Lets the brief editor render a panel showing which Mimir notes contributed to the current draft. NULL if generation predated this feature.';
