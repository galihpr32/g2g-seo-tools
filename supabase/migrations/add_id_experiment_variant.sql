-- Sprint BRAGI.ID.NATIVE — A/B test ID-native vs EN→translate
--
-- We're testing whether Indonesian copy written directly by an Indonesian-
-- prompted model outperforms English copy that's then translated by Haiku.
-- Random 50/50 across T1+T2 (Galih's choice — stratified by tier would
-- have been cleaner but loses statistical power with our volume).
--
-- Variants:
--   • 'en_translate' — current flow: EN brief → Haiku translates to ID
--   • 'id_native'    — new flow:     prompt directly in Bahasa Indonesia
--
-- We persist on seo_content_briefs (not a sidecar table) so all downstream
-- analytics (GSC, GA4, brief outcomes) automatically join by brief_id with
-- zero extra plumbing. The metric report does:
--   GROUP BY id_experiment_variant
--   on brief_review_feedback, gsc_ranking_snapshots, etc.
--
-- assigned_at lets us filter out pre-experiment briefs from the metric.
-- locked = TRUE prevents accidental flips after first generation.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS id_experiment_variant      text
    CHECK (id_experiment_variant IN ('en_translate', 'id_native')),
  ADD COLUMN IF NOT EXISTS id_experiment_assigned_at  timestamptz,
  ADD COLUMN IF NOT EXISTS id_experiment_locked       boolean NOT NULL DEFAULT false;

-- Partial index because most briefs (early days of experiment) won't have
-- a variant assigned. Friday KPI digest filters WHERE variant IS NOT NULL.
CREATE INDEX IF NOT EXISTS seo_content_briefs_id_experiment_idx
  ON public.seo_content_briefs (id_experiment_variant)
  WHERE id_experiment_variant IS NOT NULL;

COMMENT ON COLUMN public.seo_content_briefs.id_experiment_variant IS
  'A/B variant for ID-native vs EN-translate experiment (Sprint BRAGI.ID.NATIVE). NULL = not enrolled (e.g. non-tier, T0).';
COMMENT ON COLUMN public.seo_content_briefs.id_experiment_locked IS
  'Once true, variant cannot be changed — prevents accidental flips on regenerate.';
