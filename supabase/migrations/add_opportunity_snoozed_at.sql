-- ── Snooze tracking for opportunities ───────────────────────────────────────
-- snoozed_at lets the UI show "snoozed N days ago" + lets the auto-snooze
-- cron be idempotent (won't keep updating already-snoozed rows since they
-- no longer match status='new').

alter table public.seo_opportunities
  add column if not exists snoozed_at timestamptz;

-- Convenience: status check expanded to include 'snoozed'.
-- (No-op if already in the enum/check; we avoid touching the constraint
-- since other code may already write 'snoozed' as a free-form text.)
