-- ── Slack multi-channel routing config ────────────────────────────────────
-- Per (owner × notification_type) → webhook URL. Lets each kind of
-- automated Slack post land in a different channel:
--   - agent_performance → #team-marketing
--   - tier_summary      → #seo-ops
--   - daily_alerts      → #seo-alerts
--   - cms_alerts        → #seo-ops (or DM)
--   - bug_reports       → #product-feedback
--   - weekly_report     → #stakeholders
--   - general           → fallback for anything not explicitly mapped
--
-- Fallback order when posting:
--   1. owner-specific row for (notification_type, site_slug) — most specific
--   2. owner-specific row for (notification_type, site_slug=null) — site-agnostic
--   3. env var SLACK_WEBHOOK_URL — global default
--
-- No row found → use env var (so existing behaviour preserved on Day-0).

CREATE TABLE IF NOT EXISTS public.slack_routing_config (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  /** Optional brand scope — when null, applies to all brands for this owner. */
  site_slug           text,

  notification_type   text NOT NULL CHECK (notification_type IN (
    'agent_performance', 'tier_summary', 'weekly_report',
    'daily_alerts', 'cms_alerts', 'bug_reports', 'general'
  )),
  webhook_url         text NOT NULL,
  /** Display label for the channel (just for UI — not used for posting). */
  channel_label       text,
  /** Soft-toggle the route without deleting (e.g. paused over weekends). */
  enabled             boolean NOT NULL DEFAULT true,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  /** One config per (owner × site × type) — null site_slug counts distinct. */
  UNIQUE (owner_user_id, site_slug, notification_type)
);

CREATE INDEX IF NOT EXISTS slack_routing_lookup_idx
  ON public.slack_routing_config (owner_user_id, notification_type)
  WHERE enabled = true;

ALTER TABLE public.slack_routing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own Slack routing"
  ON public.slack_routing_config FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

COMMENT ON TABLE public.slack_routing_config IS
  'Per-notification-type Slack webhook routing. NULL row OR no row → fallback to env SLACK_WEBHOOK_URL.';
