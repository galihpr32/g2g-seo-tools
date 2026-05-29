-- ── Outreach follow-up flag ─────────────────────────────────────────────────
-- Sprint 9.1: cron flips needs_followup=true when last_sent_at >5d AND
-- last_replied_at is null. UI surfaces these in a dedicated tab so
-- Specialist 2 doesn't have to remember.
--
-- A boolean column instead of computing on read because:
--  1. We want stable ordering across renders (no WHERE-clause noise)
--  2. Allows the cron to also send a Slack ping when count crosses a threshold
--  3. Specialist 2 can manually clear the flag after sending the follow-up

alter table public.outreach_prospects
  add column if not exists needs_followup    boolean not null default false,
  add column if not exists followup_flagged_at timestamptz;

create index if not exists outreach_prospects_needs_followup_idx
  on public.outreach_prospects (owner_user_id, needs_followup, last_sent_at desc)
  where needs_followup = true;
