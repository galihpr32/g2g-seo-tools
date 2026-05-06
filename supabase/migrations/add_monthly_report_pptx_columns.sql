-- ── Persist generated PPTX Drive link on monthly_reports ────────────────────
-- Lets the UI show "View PPTX" instantly when reopening a report that's
-- already been exported, without round-tripping to Drive every time.
--
-- The /api/reports/monthly/export-pptx route writes these columns; if the
-- migration hasn't been applied yet the route catches the failure (non-
-- fatal) and still returns the share link to the user.

ALTER TABLE public.monthly_reports
  ADD COLUMN IF NOT EXISTS pptx_drive_id      text,
  ADD COLUMN IF NOT EXISTS pptx_drive_url     text,
  ADD COLUMN IF NOT EXISTS pptx_generated_at  timestamptz;
