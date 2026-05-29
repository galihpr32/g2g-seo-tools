-- ── Marketing intro paragraph (H1 lead) ──────────────────────────────────────
-- Galih's spec 2026-05-12: AI output should follow the same structure as a
-- real product page — H1 (marketing_title) → lead paragraph (intro) → 8 H2
-- body sections → FAQ. The intro is a 40-60 word hook-paragraph that sits
-- between the H1 and the first H2.
--
-- Sheet column L (between marketing_title at K and section 1 at M).

ALTER TABLE public.product_content_queue
  ADD COLUMN IF NOT EXISTS marketing_intro    text,
  ADD COLUMN IF NOT EXISTS id_marketing_intro text;

COMMENT ON COLUMN public.product_content_queue.marketing_intro
  IS 'Lead paragraph between H1 (marketing_title) and the first H2 section. ~40-60 words, plain prose, no heading.';
