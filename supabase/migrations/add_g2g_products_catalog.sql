-- ── G2G canonical product catalog ──────────────────────────────────────────
-- Source of truth for the 13k+ products in the G2G CMS. Imported via CSV
-- export from the admin (manually, per release). Lets the rest of the tool
-- skip the discovery GET on every CMS upload, autocomplete tier admin entries,
-- validate sheet relation_ids, and cross-reference SEO opportunities back to
-- real products.
--
-- Re-import policy (chosen 2026-05-13): UPSERT + mark missing as inactive.
-- A row absent from a fresh CSV is_active = false so we keep historical
-- references (opportunities, briefs, etc.) without losing the product
-- entirely.

CREATE TABLE IF NOT EXISTS public.g2g_products (
  /** Same UUID the CMS uses for /offer/keyword_relation/{id}. Our existing
   *  product_content_queue.relation_id joins to this. */
  relation_id       uuid PRIMARY KEY,
  /** UUID — used for PUT /offer/product_settings (FAQ endpoint). */
  service_id        uuid NOT NULL,
  /** Slug-style string e.g. 'lgc_game_26029'. Used by /offer/product_settings. */
  brand_id          text NOT NULL,
  /** Category, e.g. 'Accounts', 'Top Up', 'Gift Cards' — 9 values across catalog. */
  service_name      text NOT NULL,
  /** Brand / game / product family, e.g. 'Identity-v', 'Genshin Impact'. */
  brand_name        text NOT NULL,
  /** created_at from the source CMS row, NOT our import time. */
  cms_created_at    timestamptz,

  /** Future-proofing — every other table uses site_slug so we keep the column
   *  even though today the canonical only covers G2G. */
  site_slug         text NOT NULL DEFAULT 'g2g',

  /** Set false when a row vanishes from a later CSV import — keeps history. */
  is_active         boolean NOT NULL DEFAULT true,

  /** Timestamp of the import run that last touched (insert/update/saw) this row.
   *  Rows whose last_imported_at < latest run timestamp get marked is_active=false. */
  last_imported_at  timestamptz NOT NULL DEFAULT now(),

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Helpful lookups —
-- 1. brand_name search (lower) for typeahead/autocomplete in tier admin
CREATE INDEX IF NOT EXISTS g2g_products_brand_name_idx
  ON public.g2g_products (lower(brand_name));

-- 2. service_name (category) filter for rankings + coverage dashboards
CREATE INDEX IF NOT EXISTS g2g_products_service_name_idx
  ON public.g2g_products (service_name);

-- 3. brand_id lookup (rare but used during CMS upload cache hits)
CREATE INDEX IF NOT EXISTS g2g_products_brand_id_idx
  ON public.g2g_products (brand_id);

-- 4. Common compound filter: active rows in a category
CREATE INDEX IF NOT EXISTS g2g_products_active_service_idx
  ON public.g2g_products (is_active, service_name) WHERE is_active = true;

-- ── Import run history (for the audit log in admin UI) ──────────────────────
CREATE TABLE IF NOT EXISTS public.g2g_catalog_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  /** Filename or label entered by the user. */
  source_label    text,
  /** Total rows seen in the CSV. */
  rows_total      integer NOT NULL DEFAULT 0,
  rows_inserted   integer NOT NULL DEFAULT 0,
  rows_updated    integer NOT NULL DEFAULT 0,
  rows_unchanged  integer NOT NULL DEFAULT 0,
  /** Rows present in the previous import but missing from this one — newly
   *  marked is_active=false. */
  rows_deactivated integer NOT NULL DEFAULT 0,
  /** First import notes / error string if any rows were rejected. */
  notes           text
);

CREATE INDEX IF NOT EXISTS g2g_catalog_imports_when_idx
  ON public.g2g_catalog_imports (imported_at DESC);

-- ── Opportunity → product link (added so Sprint CATALOG.9 can backfill) ─────
-- Lives on seo_opportunities, not as a separate table — single optional
-- foreign key keeps query simple.
ALTER TABLE public.seo_opportunities
  ADD COLUMN IF NOT EXISTS matched_relation_id  uuid REFERENCES public.g2g_products(relation_id) ON DELETE SET NULL,
  /** 0.0 – 1.0 fuzzy match score (Levenshtein-derived); UI shows "high/med/low" pill. */
  ADD COLUMN IF NOT EXISTS match_score          numeric(3,2),
  /** Timestamp of the last mapping pass; lets us avoid re-running on stable rows. */
  ADD COLUMN IF NOT EXISTS matched_at           timestamptz;

CREATE INDEX IF NOT EXISTS seo_opportunities_matched_idx
  ON public.seo_opportunities (matched_relation_id) WHERE matched_relation_id IS NOT NULL;

-- ── product_content_queue: link to canonical when sheet validation passes ───
-- Already has g2g_brand_id + g2g_service_id (from CMS sprint). We don't add
-- a FK to g2g_products to avoid blocking legacy rows whose relation_id was
-- typed by hand before the catalog existed; the validator soft-checks.

-- ── product_tiers: backfill ready link to catalog ──────────────────────────
-- Same reasoning — soft reference, no FK constraint.

COMMENT ON TABLE public.g2g_products IS
  'Canonical mirror of G2G CMS product catalog. Source: weekly CSV export from admin. Used to skip CMS discovery GETs, typeahead in tier admin, fuzzy-map SEO opportunities, and gap-analysis dashboards.';
COMMENT ON TABLE public.g2g_catalog_imports IS
  'Audit log of each CSV import. Powers the admin page "Last sync" widget.';
