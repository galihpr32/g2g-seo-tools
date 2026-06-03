-- Sprint KW.BREAKDOWN.PUBLIC (350) — public access token for Friday KPI
-- Keyword Breakdown snapshots.
--
-- Pattern mirrors weekly_reports.public_token:
--   • Auto-generated UUID per row at insert time
--   • Unique index so the public route can fetch by token without ambiguity
--   • RLS bypass uses service_role (the public route reads via service client)
--
-- Anyone with the token can view that single (owner × site × week) snapshot.
-- Tokens are NOT signed/expiring — share carefully. Rotate by deleting the
-- row and rebuilding (next Refresh assigns a fresh token).

ALTER TABLE public.friday_kpi_keyword_breakdown
  ADD COLUMN IF NOT EXISTS public_token uuid NOT NULL DEFAULT gen_random_uuid();

-- Backfill any rows that pre-existed the column (DEFAULT only fires for
-- new inserts; existing rows need explicit assignment).
UPDATE public.friday_kpi_keyword_breakdown
   SET public_token = gen_random_uuid()
 WHERE public_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS friday_kpi_keyword_breakdown_public_token_idx
  ON public.friday_kpi_keyword_breakdown (public_token);

COMMENT ON COLUMN public.friday_kpi_keyword_breakdown.public_token IS
  'Unguessable UUID for /public/friday-kpi/keywords/[token] read-only view. Auto-generated on insert.';

NOTIFY pgrst, 'reload schema';
