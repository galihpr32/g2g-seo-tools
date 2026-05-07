-- ── Brief blocker fields ────────────────────────────────────────────────────
-- Lets Specialist 1 flag a brief as externally blocked (waiting on legal,
-- design, IT) without losing it from the queue. UI surfaces a yellow
-- "Blocked" badge so the brief stays visible but doesn't accrue cycle-time
-- penalty against the assignee.

alter table public.seo_content_briefs
  add column if not exists blocker_reason   text,
  add column if not exists blocked_at       timestamptz;

-- Note: we don't add 'blocked' to a status check constraint because briefs
-- already use a flexible text status field. UI surfaces "blocked" via the
-- presence of blocker_reason — orthogonal to the lifecycle status.
-- This means a brief can be (status='draft', blocker='waiting on legal')
-- and surface as both "Draft" and "Blocked" simultaneously.

create index if not exists briefs_blocked_idx
  on public.seo_content_briefs (owner_user_id, blocked_at)
  where blocker_reason is not null;
