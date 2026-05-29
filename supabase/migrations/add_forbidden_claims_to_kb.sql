-- ── Knowledge Base: forbidden_claims hard-stop list ───────────────────────
-- BDT feedback (May 2026): Bragi sometimes invents specific promises about
-- customer service resolution times, refund windows, etc. — claims that
-- Google's reviewers may flag as unreliable (and that legal can't back).
--
-- We bake a 'forbidden_claims' KB item into the brand knowledge_base_items
-- row. The brief generator injects this as a hard "DO NOT WRITE" block in
-- every prompt.
--
-- This migration is data-only — knowledge_base_items.data is JSONB and we're
-- adding a default key. The brief generator falls back to an empty array if
-- the key isn't present, so existing rows keep working until manually edited.

-- Seed default forbidden_claims for any existing brand KB rows that don't
-- already have one. Owners can edit via the KB admin later.
UPDATE public.knowledge_base_items
   SET data = jsonb_set(
     data,
     '{forbidden_claims}',
     '[
       "Specific customer support resolution times (e.g. \"resolved within 24-48 hours\") — CS SLAs vary and Google may flag.",
       "Refund percentages or guaranteed refund windows (e.g. \"100% refund\", \"7-day money back\") — depends on payment method and seller.",
       "Specific delivery time promises (e.g. \"delivered in 5 minutes\") — varies per seller. Use \"fast delivery\" or \"instant where available\" instead.",
       "Comparisons to competitors by name (Eldorado, PlayerAuctions, etc.) — no direct competitor mentions.",
       "Discount percentages we cannot back (e.g. \"up to 80% off retail\") unless the page is for a verified-discount product.",
       "Account ownership transfer claims that violate game ToS (e.g. \"fully owned forever\") — most game accounts violate ToS on transfer; phrase as \"high-tier account access\"."
     ]'::jsonb,
     true
   )
 WHERE category = 'brand'
   AND (data->'forbidden_claims') IS NULL;

COMMENT ON COLUMN public.knowledge_base_items.data IS
  'JSONB blob. For category=''brand'' rows we now expect: { tone, audience, dos: [], donts: [], notes, forbidden_claims: [] }.';
