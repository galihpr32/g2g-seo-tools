-- Sprint HUGIN.BASELINE.1 — Baseline scan job tracker.
--
-- The cron-based Hugin aggregator reads from gsc_query_snapshots, which
-- starts empty on fresh deploys. To bootstrap discovery without waiting
-- weeks for the daily cron to accumulate data, the baseline scan fetches
-- historical GSC search analytics directly from Google's API, week by
-- week, and writes into gsc_query_snapshots. Then auto-cascades to
-- runHuginAggregator so hugin_queries is populated immediately.
--
-- Job model: chunked async. start endpoint creates the run + populates
-- pending_weeks (list of {start, end} dates). tick endpoint pops next
-- week, fetches from GSC, writes, advances counter. Client polls status
-- and drives ticks via a setInterval loop.
--
-- Why chunk by week vs single fetch: GSC searchanalytics rowLimit caps
-- around 25k rows per call. A busy site for 1 week = 5-15k rows which
-- fits comfortably. 90 days in one call would likely be truncated.

CREATE TABLE IF NOT EXISTS hugin_baseline_runs (
  id                   uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid           NOT NULL,
  site_slug            text           NOT NULL,
  gsc_property_url     text           NOT NULL,
  duration_days        integer        NOT NULL,

  status               text           NOT NULL DEFAULT 'pending',
  -- 'pending' | 'running' | 'aggregating' | 'completed' | 'failed' | 'cancelled'

  total_weeks          integer        NOT NULL DEFAULT 0,
  completed_weeks      integer        NOT NULL DEFAULT 0,
  total_rows_fetched   integer        NOT NULL DEFAULT 0,

  -- Remaining weeks to process. Each entry = { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' }
  pending_weeks        jsonb          NOT NULL DEFAULT '[]'::jsonb,

  error_message        text,
  warnings             jsonb          NOT NULL DEFAULT '[]'::jsonb,

  -- Auto-cascade aggregator result (populated when scan completes)
  aggregator_result    jsonb,

  started_at           timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hugin_baseline_runs_owner_site
  ON hugin_baseline_runs (owner_user_id, site_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hugin_baseline_runs_status
  ON hugin_baseline_runs (status) WHERE status IN ('pending', 'running', 'aggregating');

COMMENT ON TABLE hugin_baseline_runs
  IS 'Sprint HUGIN.BASELINE — historical GSC backfill jobs. Powers /hugin "Run baseline scan" UI.';
