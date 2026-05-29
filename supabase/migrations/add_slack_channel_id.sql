-- Sprint FRIDAY.KPI.GRAPH.5 — Slack files.upload support.
--
-- Webhook URLs can only post text + blocks; they can't attach files. To
-- deliver the Friday KPI digest as a PNG image (the new graph-based report),
-- we need files.uploadV2 which requires a bot token + channel ID.
--
-- Adds slack_channel_id (e.g. 'C01234ABCDE') to slack_routing_config so the
-- digest knows where to upload. Webhook URL stays as the fallback path —
-- if channel_id is null, we still post via webhook with text/blocks only.

ALTER TABLE public.slack_routing_config
  ADD COLUMN IF NOT EXISTS slack_channel_id text;

COMMENT ON COLUMN public.slack_routing_config.slack_channel_id IS
  'Optional Slack channel ID (e.g. C01234ABCDE). When set + SLACK_BOT_TOKEN env present, Friday KPI digest uploads PNG via files.uploadV2. Falls back to webhook_url if null.';
