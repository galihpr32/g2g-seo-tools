-- ── Notification Settings ─────────────────────────────────────────────────────
-- Per-user toggles for Slack / push notifications.
-- The cron job reads this table instead of relying on a hard-coded env var.

create table if not exists public.notification_settings (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  slack_clicks_alerts   boolean not null default false,
  slack_cwv_alerts      boolean not null default false,
  slack_index_alerts    boolean not null default true,
  updated_at            timestamptz not null default now()
);

alter table public.notification_settings enable row level security;

create policy "Users manage own notification settings"
  on public.notification_settings for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Allow service-role (cron) to read all rows
-- Service role bypasses RLS by default in Supabase, so no extra policy needed.
