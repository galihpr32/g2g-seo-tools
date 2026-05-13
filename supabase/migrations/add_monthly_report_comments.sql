-- ── Monthly report inline commentary ───────────────────────────────────────-
-- Sprint 10.2: Head can leave inline comments per section of the monthly
-- report viewer (/reports/monthly). Comments persist + render in the
-- PPTX export under each section so the artifact mirrors what's on
-- screen.

create table if not exists public.monthly_report_comments (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  site_slug       text not null default 'g2g',
  /** YYYY-MM (no day) — one comment thread per section per month-of-report */
  report_month    text not null,
  /** Section key from the viewer page — e.g. 'kpi', 'channel_breakdown',
   *  'search_trend', 'top_pages', 'experiments', 'site_health',
   *  'tech_summary', 'key_takeaways', 'action_plan'.
   *  Free-form text so future sections don't need a migration. */
  section_key     text not null,
  body            text not null,
  /** Author can be the owner or a workspace_member who has edit rights. */
  author_user_id  uuid not null references auth.users(id) on delete set null,
  author_name     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.monthly_report_comments enable row level security;

create policy "Users manage own report comments"
  on public.monthly_report_comments for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

create index if not exists monthly_report_comments_lookup_idx
  on public.monthly_report_comments (owner_user_id, site_slug, report_month, section_key);

-- Trigger to keep updated_at fresh
create or replace function set_monthly_report_comments_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists monthly_report_comments_updated_at on public.monthly_report_comments;
create trigger monthly_report_comments_updated_at
  before update on public.monthly_report_comments
  for each row execute function set_monthly_report_comments_updated_at();
