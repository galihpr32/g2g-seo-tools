-- ── Add category to product_tiers ────────────────────────────────────────────
-- Group Tier 1 + Tier 2 products by category (e.g. "Game Coins", "Accounts",
-- "Gift Cards", "Boosting") so the admin UI + Priority Products page can
-- render them in sections instead of one flat list. Galih's quote:
-- "klasifikasi per kategori dong. jadi tiap kategori, punya top tier list-nya.
--  kelompokannya jadi jauh lebih enak dan teratur".
--
-- Free-form text — same shape as product_content_queue.category — so the UI
-- can offer a curated preset list but still accept custom values.

ALTER TABLE public.product_tiers
  ADD COLUMN IF NOT EXISTS category text;

-- Index for the per-(owner+site+category) filter on the admin + Priority pages
CREATE INDEX IF NOT EXISTS product_tiers_category_idx
  ON public.product_tiers (owner_user_id, site_slug, category)
  WHERE category IS NOT NULL;
