-- ── Sprint WEEKLY.SLACK.PUBLIC-PNG ────────────────────────────────────────
-- Stores the rendered Weekly Report PNG bytes alongside the weekly_reports
-- row so outsiders can hit /public/weekly/png/[token] without auth.
--
-- BYTEA chosen over Supabase Storage to keep the setup self-contained.
-- One PNG per fire, ~500KB-2MB, ~52 fires/year → ~50MB/year total. Fine.

ALTER TABLE public.weekly_reports
  ADD COLUMN IF NOT EXISTS png_data         bytea,
  ADD COLUMN IF NOT EXISTS png_generated_at timestamptz;

COMMENT ON COLUMN public.weekly_reports.png_data IS
  'Rendered Weekly Report PNG (one per fire, combined both brands). NULL until first delivery writes it.';
COMMENT ON COLUMN public.weekly_reports.png_generated_at IS
  'Timestamp when png_data was last written. Used to find latest PNG for /public/weekly/png/latest.';

-- Refresh PostgREST schema cache so the new columns are visible immediately
NOTIFY pgrst, 'reload schema';
