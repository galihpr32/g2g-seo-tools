-- ── Outreach reply log ──────────────────────────────────────────────────────
-- Until we wire Gmail OAuth (later phase), Specialist 2 manually pastes
-- inbound email replies via "Log reply" button. We persist them as JSONB
-- so we don't need a separate table for v1.

ALTER TABLE public.outreach_prospects
  ADD COLUMN IF NOT EXISTS replies         jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS sent_count      int   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sent_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_replied_at timestamptz;

-- Each entry in `replies` JSONB:
--   {
--     "ts":          "2026-05-08T...Z",
--     "direction":   "outbound" | "inbound",
--     "sentiment":   "positive" | "neutral" | "negative" | null,
--     "body":        "<paste of email content, max 5000 chars>",
--     "logged_by":   "<user_id>"
--   }

-- Index for "needs follow-up" filter — find prospects sent ≥ 5 days ago with
-- no inbound reply since.
CREATE INDEX IF NOT EXISTS outreach_prospects_followup_idx
  ON public.outreach_prospects (last_sent_at)
  WHERE last_replied_at IS NULL;
