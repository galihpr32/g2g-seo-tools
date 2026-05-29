-- ── Tyr auto-publish thresholds ────────────────────────────────────────────
-- Per (owner × site × tier-level), define rules for when a brief can skip
-- human review and go straight to "auto_approved" state. Drives the removal
-- of the manual review bottleneck for top 10 + non-top product workflows.
--
-- Decision logic (in priority order):
--   1. If brief output is for tier_level 1 product AND tier=1 row exists with
--      auto_publish_enabled=true → check threshold rules
--   2. Else if tier_level 2 product → use tier=2 row
--   3. Else (non-tier product) → use tier=0 row (most lenient defaults)
--
-- Threshold rules:
--   - `min_tyr_score`           — overall Tyr score must be ≥
--   - `min_dimension_threshold` — every per-dimension score must be ≥
--   - `forbidden_violations_max` — max number of forbidden-claim hits
--     (computed by Bragi during generation; 0 = strict, ≥1 = lenient)
--
-- Status flow:
--   draft → tyr_reviewed → (auto_approved | needs_review)
--                            → published

CREATE TABLE IF NOT EXISTS public.tyr_autopublish_config (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug                text NOT NULL DEFAULT 'g2g',
  /** 0 = non-tier (most products), 1 = Tier 1 top 10, 2 = Tier 2 next 25. */
  tier_level               integer NOT NULL CHECK (tier_level IN (0, 1, 2)),

  auto_publish_enabled     boolean NOT NULL DEFAULT false,
  /** Tyr scores brief 0-100. Higher = better. */
  min_tyr_score            integer NOT NULL DEFAULT 75 CHECK (min_tyr_score BETWEEN 0 AND 100),
  /** Per-dimension floor — every dimension must be ≥ this OR brief fails. */
  min_dimension_threshold  integer NOT NULL DEFAULT 6 CHECK (min_dimension_threshold BETWEEN 0 AND 10),
  /** Max forbidden-claim violations allowed. 0 = zero tolerance. */
  forbidden_violations_max integer NOT NULL DEFAULT 0 CHECK (forbidden_violations_max >= 0),

  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, site_slug, tier_level)
);

ALTER TABLE public.tyr_autopublish_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own autopublish config"
  ON public.tyr_autopublish_config FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- ── seo_content_briefs: status enum needs new value 'auto_approved' ─────
-- We accept the new state without dropping/recreating an enum (the column
-- is text). Document the values here.

COMMENT ON COLUMN public.seo_content_briefs.status IS
  'Brief lifecycle: draft → tyr_reviewed → (auto_approved | needs_review) → published. auto_approved skips human review when tyr_autopublish_config conditions are met.';

-- ── Backfill default config rows for existing brand owners ─────────────
-- Conservative defaults — tier 1 stays manual until SEO team adjusts.
INSERT INTO public.tyr_autopublish_config (owner_user_id, site_slug, tier_level, auto_publish_enabled, min_tyr_score, min_dimension_threshold, forbidden_violations_max, notes)
SELECT DISTINCT owner_user_id, site_slug, 0, true,  70, 6, 0, 'Non-tier products — auto-publish enabled by default with conservative threshold.'
FROM public.product_tiers
ON CONFLICT (owner_user_id, site_slug, tier_level) DO NOTHING;

INSERT INTO public.tyr_autopublish_config (owner_user_id, site_slug, tier_level, auto_publish_enabled, min_tyr_score, min_dimension_threshold, forbidden_violations_max, notes)
SELECT DISTINCT owner_user_id, site_slug, 2, true,  80, 7, 0, 'Tier 2 (next 25) — auto-publish enabled with stricter threshold.'
FROM public.product_tiers
ON CONFLICT (owner_user_id, site_slug, tier_level) DO NOTHING;

INSERT INTO public.tyr_autopublish_config (owner_user_id, site_slug, tier_level, auto_publish_enabled, min_tyr_score, min_dimension_threshold, forbidden_violations_max, notes)
SELECT DISTINCT owner_user_id, site_slug, 1, false, 85, 8, 0, 'Tier 1 (top 10) — manual review required by default. Enable + tune threshold once team confident.'
FROM public.product_tiers
ON CONFLICT (owner_user_id, site_slug, tier_level) DO NOTHING;
