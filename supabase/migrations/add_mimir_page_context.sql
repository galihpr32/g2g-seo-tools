-- ── Mimir Level B — page-aware conversations ──────────────────────────────
-- Existing mimir_conversations only supported the experiments page.
-- Level B = Mimir embedded in many pages (monthly report, weekly report,
-- opportunities, ranking drops). Each page passes `page_context` describing
-- what Mimir should load:
--   { "kind": "monthly_report",  "id": "<report_uuid>" }
--   { "kind": "weekly_report",   "id": "<report_uuid>" }
--   { "kind": "opportunities",   "filter": "high-priority" }
--   { "kind": "ranking_drops",   "since": "2026-04-01" }
--   { "kind": "experiments" }                              ← existing usage
--   { "kind": "brief",           "id": "<brief_uuid>" }
--
-- Adding it as JSONB lets us evolve context shapes without further migrations.

ALTER TABLE public.mimir_conversations
  ADD COLUMN IF NOT EXISTS page_context jsonb;

-- Hot-path: "show me Mimir conversations on this page" (e.g. when opening
-- the monthly report viewer, list past Mimir threads scoped to that report).
-- We index on the `kind` field specifically — that's the most-queried key.
CREATE INDEX IF NOT EXISTS mimir_conversations_page_kind_idx
  ON public.mimir_conversations USING gin ((page_context -> 'kind'));

-- Backfill: existing rows are all from the experiments page.
UPDATE public.mimir_conversations
   SET page_context = '{"kind":"experiments"}'::jsonb
 WHERE page_context IS NULL;
