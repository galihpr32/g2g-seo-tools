-- ── OffGamers Phase 1: Multi-site data isolation ─────────────────────────────
-- Run this before any OffGamers-specific data is written.
-- All existing rows default to 'g2g' — no data loss, no G2G regressions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Set OffGamers GA4 property ID in site_configs ─────────────────────────
UPDATE public.site_configs
SET ga4_property_id = '382569541'
WHERE slug = 'offgamers';

-- Verify the OG row looks correct (manual check after applying):
-- SELECT slug, display_name, gsc_property, ga4_property_id FROM site_configs;


-- ── 2. monthly_reports — add site_slug, fix unique constraint ────────────────
-- The old UNIQUE(owner_user_id, month_start) only allows one report per month
-- across all sites. Replace it with a per-site constraint.

ALTER TABLE public.monthly_reports
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

-- Drop the old single-site unique constraint
ALTER TABLE public.monthly_reports
  DROP CONSTRAINT IF EXISTS monthly_reports_owner_user_id_month_start_key;

-- New constraint: one report per (owner, site, month)
ALTER TABLE public.monthly_reports
  ADD CONSTRAINT monthly_reports_owner_site_month_key
  UNIQUE (owner_user_id, site_slug, month_start);

-- Update index to include site_slug
DROP INDEX IF EXISTS monthly_reports_owner_idx;
CREATE INDEX IF NOT EXISTS monthly_reports_owner_site_idx
  ON public.monthly_reports (owner_user_id, site_slug, month_start DESC);


-- ── 3. competitors — add site_slug ───────────────────────────────────────────
-- G2G and OffGamers compete in different spaces — separate per site.
-- All existing competitors belong to G2G (default 'g2g').

ALTER TABLE public.competitors
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS competitors_site_slug_idx
  ON public.competitors (owner_user_id, site_slug);


-- ── 4. keyword_maps — add site_slug ─────────────────────────────────────────

ALTER TABLE public.keyword_maps
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS keyword_maps_site_slug_idx
  ON public.keyword_maps (owner_user_id, site_slug);


-- ── 5. outreach_prospects — add site_slug ────────────────────────────────────

ALTER TABLE public.outreach_prospects
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS outreach_prospects_site_slug_idx
  ON public.outreach_prospects (owner_user_id, site_slug);


-- ── 6. outreach_domain_scores — add site_slug + fix unique constraint ────────
-- Hermod eval scores are brand-context-dependent (outreach_angle, audience_score
-- differ between G2G and OG). Each brand gets its own cache row per domain.

ALTER TABLE public.outreach_domain_scores
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

-- Drop old constraint (owner_user_id, domain) — too narrow for multi-brand
ALTER TABLE public.outreach_domain_scores
  DROP CONSTRAINT IF EXISTS outreach_domain_scores_owner_user_id_domain_key;

-- New constraint: one score row per (owner, site, domain)
ALTER TABLE public.outreach_domain_scores
  ADD CONSTRAINT outreach_domain_scores_owner_site_domain_key
  UNIQUE (owner_user_id, site_slug, domain);

CREATE INDEX IF NOT EXISTS outreach_domain_scores_site_slug_idx
  ON public.outreach_domain_scores (owner_user_id, site_slug, overall_score DESC);


-- ── 7. seo_action_items — add site_slug ──────────────────────────────────────
-- Note: this table uses site_url (not owner_user_id) as its primary filter.
-- Index accordingly.

ALTER TABLE public.seo_action_items
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS seo_action_items_site_slug_idx
  ON public.seo_action_items (site_slug);


-- ── 8. seo_content_briefs — add site_slug ────────────────────────────────────
-- Same pattern: filtered by site_url, not owner_user_id.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS seo_content_briefs_site_slug_idx
  ON public.seo_content_briefs (site_slug);
