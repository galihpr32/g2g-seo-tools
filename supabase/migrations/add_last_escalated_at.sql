-- ── Tech-debt real-time alert tracking ─────────────────────────────────
-- Sprint TECH.REALTIME — adds last_escalated_at to seo_action_items so
-- the real-time INSERT-trigger and weekly digest don't double-fire on the
-- same row. Insert-time alert sets this; weekly digest checks it to know
-- which items have already been escalated.

-- Add priority column too if it doesn't exist yet — needed by broken-urls
-- create-action route which sets 'high'/'medium'/'low'.
ALTER TABLE public.seo_action_items
  ADD COLUMN IF NOT EXISTS priority          text DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS last_escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS seo_action_items_escalation_idx
  ON public.seo_action_items (created_at)
  WHERE last_escalated_at IS NULL AND status != 'done';

COMMENT ON COLUMN public.seo_action_items.last_escalated_at IS
  'Timestamp when this item was first Slack-escalated. NULL = never alerted. Updated by helper at insert time + weekly digest.';
