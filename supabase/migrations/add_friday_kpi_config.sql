-- Sprint FRIDAY.KPI.GRAPH.1 — config table for Friday KPI canon source.
--
-- Default canon = 'gsc' since real-world impressions are more meaningful for
-- stakeholder reports than DFS-scraped positions. Override per workspace.

CREATE TABLE IF NOT EXISTS public.friday_kpi_config (
  owner_user_id   uuid        PRIMARY KEY,
  canon_source    text        NOT NULL DEFAULT 'gsc'
                              CHECK (canon_source IN ('dfs', 'gsc')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.friday_kpi_config
  IS 'Sprint FRIDAY.KPI.GRAPH.1 — per-workspace config for Friday KPI report. Right now just the canon data source (DFS scrape vs real GSC).';

COMMENT ON COLUMN public.friday_kpi_config.canon_source
  IS 'Which data source to use as the authoritative numbers in Friday KPI. "dfs" = DataForSEO weekly SERP scrape (intent rankings). "gsc" = Google Search Console (real impressions, what stakeholders actually see).';

ALTER TABLE public.friday_kpi_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their own friday_kpi_config"
  ON public.friday_kpi_config FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid());

CREATE POLICY "Owners write their own friday_kpi_config"
  ON public.friday_kpi_config FOR ALL
  TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
