-- Sprint SLACK-ROUTING.FRIDAY-KPI-FIX (313) ────────────────────────────────
--
-- Bug: clicking "Create route" in /settings/slack-routing with
--   notification_type = 'friday_kpi' (or 'forseti_severe') fails silently.
-- Test ping works (no DB write); save fails because the original
--   `add_slack_routing_config.sql` CHECK constraint only allows:
--     agent_performance, tier_summary, weekly_report,
--     daily_alerts, cms_alerts, bug_reports, general
-- and Postgres rejects the INSERT with a CHECK violation.
--
-- Fix: drop the old constraint and replace it with the expanded list that
-- includes the two notification types we've added since:
--   - friday_kpi      (the weekly KPI digest — Slack PNG/webhook delivery)
--   - forseti_severe  (Forseti high-severity legal/policy alerts)
--
-- Idempotent: uses DROP CONSTRAINT IF EXISTS so it's safe to re-run.

ALTER TABLE public.slack_routing_config
  DROP CONSTRAINT IF EXISTS slack_routing_config_notification_type_check;

ALTER TABLE public.slack_routing_config
  ADD CONSTRAINT slack_routing_config_notification_type_check
  CHECK (notification_type IN (
    'agent_performance',
    'tier_summary',
    'weekly_report',
    'friday_kpi',
    'forseti_severe',
    'daily_alerts',
    'cms_alerts',
    'bug_reports',
    'general'
  ));
