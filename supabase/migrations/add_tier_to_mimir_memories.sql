-- Sprint MIMIR.TIER.LEARN.1 — Tier context on mimir_memories.
--
-- When a memory is created from a T1/T2 priority product (manual note,
-- inline brief note, or extracted feedback on a tier-product brief), tag it
-- with the tier so the retriever can prioritize it.
--
-- NULL tier = memory has no tier context (default, applies normally).
-- 1 / 2     = memory belongs to a Tier 1 / Tier 2 product; retriever boosts.
--
-- We also add product_tier_id as a direct FK shortcut, so we can join back to
-- the source tier row without going through relation_id → g2g_products → tier.

ALTER TABLE public.mimir_memories
  ADD COLUMN IF NOT EXISTS tier            smallint
    CHECK (tier IS NULL OR tier IN (1, 2)),
  ADD COLUMN IF NOT EXISTS product_tier_id uuid
    REFERENCES public.product_tiers(id) ON DELETE SET NULL;

-- Retrieval index — used by retriever to bias score toward tier-tagged memories
CREATE INDEX IF NOT EXISTS mimir_memories_tier_idx
  ON public.mimir_memories (owner_user_id, tier)
  WHERE tier IS NOT NULL AND archived = false;

CREATE INDEX IF NOT EXISTS mimir_memories_product_tier_id_idx
  ON public.mimir_memories (product_tier_id)
  WHERE product_tier_id IS NOT NULL;

COMMENT ON COLUMN public.mimir_memories.tier IS
  'Optional tier scope. NULL = no tier context. 1 = T1 product, 2 = T2 product. Retriever boosts tier-tagged memories when generating briefs for tier products.';

COMMENT ON COLUMN public.mimir_memories.product_tier_id IS
  'Optional direct FK to product_tiers row. Set when memory was created from a tier-product manual note or inline brief note.';
