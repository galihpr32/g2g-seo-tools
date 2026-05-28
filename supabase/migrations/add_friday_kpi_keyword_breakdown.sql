-- Sprint FRIDAY.KPI.KW-BREAKDOWN.1 (337) —
-- Cache table for the Friday KPI "Keyword Breakdown" sub-page. Each row
-- stores a fully-joined GA4 (revenue per landing page) × GSC (top queries
-- per page) snapshot for one (owner, site, Thu→Wed week) tuple.
--
-- The payload JSON shape (see API for exact TS type) is:
--   {
--     week_start:   'YYYY-MM-DD',
--     week_end:     'YYYY-MM-DD',
--     site_slug:    'g2g' | 'offgamers',
--     generated_at: ISO8601,
--     rows: [
--       {
--         page:         '/categories/blade-and-soul-neo',
--         sessions:     1234,
--         transactions: 12,
--         revenue:      456.78,
--         top_queries:  [
--           { query, rank, clicks, impressions }, …up to 5
--         ],
--       },
--       …
--     ],
--   }
--
-- Single row per (owner × site × week_start). Refresh = upsert.

CREATE TABLE IF NOT EXISTS public.friday_kpi_keyword_breakdown (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL,
  week_start      date NOT NULL,
  payload         jsonb NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT friday_kpi_keyword_breakdown_unique
    UNIQUE (owner_user_id, site_slug, week_start)
);

CREATE INDEX IF NOT EXISTS friday_kpi_keyword_breakdown_owner_site_idx
  ON public.friday_kpi_keyword_breakdown (owner_user_id, site_slug, week_start DESC);

-- RLS: owner can read/write own rows; service_role bypass.
ALTER TABLE public.friday_kpi_keyword_breakdown ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kw_breakdown_owner_select" ON public.friday_kpi_keyword_breakdown;
CREATE POLICY "kw_breakdown_owner_select"
  ON public.friday_kpi_keyword_breakdown
  FOR SELECT
  USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "kw_breakdown_owner_modify" ON public.friday_kpi_keyword_breakdown;
CREATE POLICY "kw_breakdown_owner_modify"
  ON public.friday_kpi_keyword_breakdown
  FOR ALL
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

COMMENT ON TABLE public.friday_kpi_keyword_breakdown IS
  'Friday KPI keyword breakdown sub-page cache. One row per (owner, site, week).';
COMMENT ON COLUMN public.friday_kpi_keyword_breakdown.payload IS
  'GA4 landing-page revenue × GSC top-query join. See API TS type for shape.';

NOTIFY pgrst, 'reload schema';
