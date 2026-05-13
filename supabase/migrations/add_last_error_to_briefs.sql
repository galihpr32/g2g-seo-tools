-- ── Brief generator hardening: surface why a brief is stuck ──────────────────
-- Up to now if Bragi crashed mid-generation (Vercel timeout, Anthropic 429,
-- network blip, etc.) the brief row stayed at status='generating' forever
-- with no diagnostic info. The user could only see "stuck" — not WHY.
--
-- These two columns get populated in the generator's catch block. The
-- separate timestamp lets the UI compute "last error 5 min ago" without
-- having to inspect log strings.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS last_error    text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

-- Helpful index for the "find recently failed" query the cron uses.
CREATE INDEX IF NOT EXISTS seo_content_briefs_last_error_at_idx
  ON public.seo_content_briefs (last_error_at DESC)
  WHERE last_error IS NOT NULL;
