-- ── Sprint CKB.BRAND-ALIAS.1 ────────────────────────────────────────────
-- Phase 1 of fixing CKB cross-product contamination (e.g. "standoff 2 top
-- up gold" leaking into a "cheap bns gold" kit because both share the
-- generic gaming token "gold").
--
-- The content-kit builder's brand-token filter needs to know specific
-- brand identifiers beyond what fits in `brand_canonical`. Game brands
-- frequently get short forms ("BNS" for Blade & Soul NEO, "FFXIV" for
-- Final Fantasy XIV, "WoW" for World of Warcraft) that aren't derivable
-- algorithmically. brand_aliases captures those.
--
-- Phase 2 (Hugin-mined suggestions) will append to this column after
-- Galih reviews auto-detected aliases.

ALTER TABLE public.product_tiers
  ADD COLUMN IF NOT EXISTS brand_aliases text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.product_tiers.brand_aliases IS
  'Brand abbreviations / nicknames used in search queries (e.g. {BNS, B&S Neo} for Blade & Soul NEO). Used by content-kit builder to widen brand-token filter beyond brand_canonical, so candidates like "bns gold farming" match while generic "standoff 2 top up gold" does not. Phase 2 mining job appends suggestions after manual approval.';

-- Refresh PostgREST schema cache so the new column is visible immediately
NOTIFY pgrst, 'reload schema';
