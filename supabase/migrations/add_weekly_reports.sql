-- ── Weekly SEO Pulse Reports ───────────────────────────────────────────────────
-- Stores generated weekly reports (Thu–Wed cadence).
-- report_data JSONB holds all fetched metrics; ai_narrative + ai_action_plan
-- hold Claude-generated text sections.

create table if not exists public.weekly_reports (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  week_start      date not null,           -- Thursday
  week_end        date not null,           -- Wednesday
  report_data     jsonb not null default '{}',
  ai_narrative    text,
  ai_action_plan  text,
  created_at      timestamptz not null default now(),
  unique (owner_user_id, week_start)
);

alter table public.weekly_reports enable row level security;

create policy "Users manage own weekly reports"
  on public.weekly_reports for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists weekly_reports_owner_week_idx
  on public.weekly_reports (owner_user_id, week_start desc);
