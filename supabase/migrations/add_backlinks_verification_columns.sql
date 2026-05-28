-- ── Backlinks verification metadata ────────────────────────────────────────
-- Auto-verify cron writes here so we can show "last checked" + reason for
-- broken status without a separate table.

ALTER TABLE public.paid_backlinks
  ADD COLUMN IF NOT EXISTS last_verified_at  timestamptz,
  ADD COLUMN IF NOT EXISTS verification_note text,    -- e.g. "Anchor missing", "404", "5xx"
  ADD COLUMN IF NOT EXISTS http_status       int;

-- Index used by the cron's "stale verifications first" query
CREATE INDEX IF NOT EXISTS paid_backlinks_verification_idx
  ON public.paid_backlinks (last_verified_at NULLS FIRST)
  WHERE link_status IN ('pending', 'active');
