-- ── 1. Site Audit Tasks ───────────────────────────────────────────────────────
-- Stores DataForSEO on-page audit task IDs and cached results per owner.
-- (Safe to re-run — uses IF NOT EXISTS)

create table if not exists public.site_audit_tasks (
  id              uuid        primary key default gen_random_uuid(),
  owner_user_id   uuid        not null references auth.users(id) on delete cascade,
  task_id         text        not null,
  target          text        not null default 'g2g.com',
  status          text        not null default 'pending',  -- pending | in_progress | finished | error
  summary         jsonb,
  error_message   text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

alter table public.site_audit_tasks enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'site_audit_tasks'
      and policyname = 'Users manage own site audit tasks'
  ) then
    execute $policy$
      create policy "Users manage own site audit tasks"
        on public.site_audit_tasks for all
        using  (auth.uid() = owner_user_id)
        with check (auth.uid() = owner_user_id)
    $policy$;
  end if;
end $$;

create index if not exists site_audit_tasks_owner_idx
  on public.site_audit_tasks (owner_user_id, created_at desc);


-- ── 2. Task Checks on Weekly Reports ─────────────────────────────────────────
-- Stores per-report checklist state for the AI Team Brief action items.
-- Shape: { [itemIndex: string]: 'todo' | 'in_progress' | 'done' }

alter table public.weekly_reports
  add column if not exists task_checks jsonb not null default '{}'::jsonb;
