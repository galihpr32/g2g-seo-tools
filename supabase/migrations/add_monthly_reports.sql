-- ── Monthly SEO Reports ───────────────────────────────────────────────────────

create table if not exists public.monthly_reports (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  month_start   date not null,
  month_end     date not null,
  report_data   jsonb not null default '{}',
  ai_narrative  text,
  ai_action_plan text,
  created_at    timestamptz not null default now(),
  unique (owner_user_id, month_start)
);

alter table public.monthly_reports enable row level security;

create policy "monthly_reports: owner full access"
  on public.monthly_reports for all
  using  (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create index if not exists monthly_reports_owner_idx
  on public.monthly_reports (owner_user_id, month_start desc);
