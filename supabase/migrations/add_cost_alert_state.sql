-- Sprint COST.ALERT — Idempotency state for monthly Anthropic cost alerts.
-- Without this, the daily cron would re-fire the warning Slack every single
-- day the spend stayed above the threshold. We record (year_month × level)
-- once per fire so each level pings exactly once per calendar month.
--
-- Schema:
--   year_month — YYYY-MM bucket (e.g. '2026-05')
--   level      — 'warning' ($28) | 'critical' ($35)
--   fired_at   — when we sent the Slack
--   spend_usd  — snapshot of monthly spend at fire time (audit trail)
--
-- A new month auto-resets because year_month changes; the partial UNIQUE
-- index prevents duplicate fires within the same month.

CREATE TABLE IF NOT EXISTS public.cost_alert_state (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid    NOT NULL,
  year_month      text    NOT NULL,                           -- 'YYYY-MM'
  level           text    NOT NULL CHECK (level IN ('warning', 'critical')),
  spend_usd       numeric NOT NULL,
  fired_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS cost_alert_state_uniq
  ON public.cost_alert_state (owner_user_id, year_month, level);

CREATE INDEX IF NOT EXISTS cost_alert_state_recent_idx
  ON public.cost_alert_state (fired_at DESC);

COMMENT ON TABLE public.cost_alert_state IS
  'One row per (owner × month × level) fired. Prevents the daily cron from re-pinging Slack every day spend stays above threshold.';
