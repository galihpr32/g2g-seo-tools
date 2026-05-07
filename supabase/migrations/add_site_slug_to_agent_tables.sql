-- ── Add site_slug to agent_runs + agent_actions ───────────────────────────
-- agent_findings already has site_slug (added in original migration).
-- agent_runs + agent_actions are missing it — agent code already writes
-- the field, but defaulting to 'g2g' here ensures backfilled rows from
-- before multi-brand support are correctly tagged. Idempotent — safe to
-- re-run.

ALTER TABLE public.agent_runs
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

ALTER TABLE public.agent_actions
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

CREATE INDEX IF NOT EXISTS agent_runs_site_slug_idx
  ON public.agent_runs (owner_user_id, site_slug, started_at DESC);

CREATE INDEX IF NOT EXISTS agent_actions_site_slug_idx
  ON public.agent_actions (owner_user_id, site_slug, status, created_at DESC);
