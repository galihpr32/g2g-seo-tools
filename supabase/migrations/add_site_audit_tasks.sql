-- ── Site Audit Tasks ──────────────────────────────────────────────────────────
-- Stores DataForSEO on-page audit task IDs and cached results per owner.
-- One row per completed/in-progress task; latest row is the active audit.

create table if not exists public.site_audit_tasks (
  id              uuid        primary key default gen_random_uuid(),
  owner_user_id   uuid        not null references auth.users(id) on delete cascade,
  task_id         text        not null,          -- DataForSEO task ID
  target          text        not null default 'g2g.com',
  status          text        not null default 'pending',  -- pending | in_progress | finished | error
  summary         jsonb,                         -- OnPageAuditSummary when finished
  error_message   text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

alter table public.site_audit_tasks enable row level security;

create policy "Users manage own site audit tasks"
  on public.site_audit_tasks for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists site_audit_tasks_owner_idx
  on public.site_audit_tasks (owner_user_id, created_at desc);
