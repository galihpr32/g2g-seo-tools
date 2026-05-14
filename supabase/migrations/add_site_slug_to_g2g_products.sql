-- ── Add site_slug column for OG parity ─────────────────────────────────
-- Sprint OG.CATALOG — extend the existing g2g_products canonical mirror
-- to hold OffGamers catalog rows too. Table name kept (avoiding rename
-- breaks too many existing callers); new column scopes per brand.
--
-- Default 'g2g' so legacy rows continue to behave identically.

ALTER TABLE public.g2g_products
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g'
    CHECK (site_slug IN ('g2g', 'offgamers'));

-- Backfill index for site-aware queries
CREATE INDEX IF NOT EXISTS g2g_products_site_slug_idx
  ON public.g2g_products (site_slug, owner_user_id);

COMMENT ON COLUMN public.g2g_products.site_slug IS
  'Brand scope. Default g2g keeps legacy behaviour; offgamers rows scoped separately for OG admin.';
