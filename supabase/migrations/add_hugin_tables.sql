-- Sprint HUGIN — Long-tail keyword discovery.
--
-- Two tables:
--   1. gsc_query_snapshots — daily comprehensive query-level snapshots from GSC.
--      Current gsc_ranking_drop_queries only saves queries for DROPPED pages.
--      Hugin needs ALL queries to detect long-tail growth/emergence, so we
--      add this comprehensive snapshot table and patch gsc-daily to populate it.
--
--   2. hugin_queries — aggregated long-tail discovery output. One row per
--      (owner × site × query × period) — e.g. "how to buy genshin" at period=30d.
--      The aggregator cron computes growth_pct, is_new, position_delta etc.
--      and upserts here. UI reads from this table.

-- ─── 1. Comprehensive daily GSC query snapshots ─────────────────────────────
CREATE TABLE IF NOT EXISTS gsc_query_snapshots (
  id              bigserial      PRIMARY KEY,
  site_url        text           NOT NULL,
  snapshot_date   date           NOT NULL,
  page            text           NOT NULL,
  query           text           NOT NULL,
  clicks          integer        NOT NULL DEFAULT 0,
  impressions     integer        NOT NULL DEFAULT 0,
  ctr             numeric(7, 6),
  position        numeric(8, 3),
  created_at      timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT gsc_query_snapshots_unique UNIQUE (site_url, snapshot_date, page, query)
);

CREATE INDEX IF NOT EXISTS idx_gsc_query_snapshots_site_date
  ON gsc_query_snapshots (site_url, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_gsc_query_snapshots_query
  ON gsc_query_snapshots (query);
CREATE INDEX IF NOT EXISTS idx_gsc_query_snapshots_date_query
  ON gsc_query_snapshots (snapshot_date DESC, query);

-- Auto-trim old rows after 120 days to keep table lean. 90d is the max
-- window Hugin needs (with some buffer for prior-period delta calc).
COMMENT ON TABLE gsc_query_snapshots
  IS 'Sprint HUGIN — comprehensive daily query-level snapshots. Auto-trimmed after 120 days.';

-- ─── 2. Hugin aggregated long-tail queries ──────────────────────────────────
CREATE TABLE IF NOT EXISTS hugin_queries (
  id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id            uuid           NOT NULL,
  site_slug                text           NOT NULL,

  -- The query itself (lowercased, trimmed for matching; preserved-case for display)
  query                    text           NOT NULL,         -- lowercased
  query_display            text,                            -- optional original casing
  word_count               integer        NOT NULL,

  -- Window the row was computed for
  period_days              integer        NOT NULL,         -- 7 | 30 | 60 | 90

  -- Volume metrics (current window)
  total_impressions        integer        NOT NULL DEFAULT 0,
  total_clicks             integer        NOT NULL DEFAULT 0,
  ctr_current              numeric(7, 6),
  position_avg             numeric(8, 3),

  -- Prior-period metrics (same-length window ending just before current)
  prior_impressions        integer        NOT NULL DEFAULT 0,
  prior_clicks             integer        NOT NULL DEFAULT 0,
  ctr_prior                numeric(7, 6),
  position_prior           numeric(8, 3),

  -- Computed deltas
  growth_pct               numeric(8, 2),                   -- % delta impressions; NULL if prior=0
  position_delta           numeric(8, 3),                   -- prior - current (positive = climbing)
  is_new                   boolean        NOT NULL DEFAULT false,   -- prior_impressions = 0

  -- Top page + market for the query (most-impressed)
  top_page                 text,
  top_market               text,

  -- Flags
  dmca_flag                boolean        NOT NULL DEFAULT false,
  phrase_pattern_match     boolean        NOT NULL DEFAULT false,   -- captured via phrase pattern, not just word count

  -- Auto-match suggestion
  auto_matched_product_id  uuid,                            -- references product_tiers; nullable
  auto_matched_product_name text,                           -- denormalized for display

  -- User workflow
  status                   text           NOT NULL DEFAULT 'discovered',
  -- 'discovered' | 'claimed' | 'covered' | 'ignored'
  claimed_to_product_id    uuid,                            -- references product_tiers; set when status='claimed'
  claimed_at               timestamptz,
  claimed_by_user_id       uuid,
  status_note              text,

  -- Aggregator metadata
  last_aggregated_at       timestamptz    NOT NULL DEFAULT now(),
  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT hugin_queries_unique UNIQUE (owner_user_id, site_slug, query, period_days)
);

CREATE INDEX IF NOT EXISTS idx_hugin_queries_owner_site_period
  ON hugin_queries (owner_user_id, site_slug, period_days);
CREATE INDEX IF NOT EXISTS idx_hugin_queries_status
  ON hugin_queries (owner_user_id, site_slug, status);
CREATE INDEX IF NOT EXISTS idx_hugin_queries_growth
  ON hugin_queries (owner_user_id, site_slug, period_days, growth_pct DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_hugin_queries_new
  ON hugin_queries (owner_user_id, site_slug, period_days, is_new) WHERE is_new = true;

COMMENT ON TABLE hugin_queries
  IS 'Sprint HUGIN — aggregated long-tail discovery. One row per (query × period).';
COMMENT ON COLUMN hugin_queries.status
  IS 'discovered = scraper found it; claimed = added to tier_keywords; covered = already ranking; ignored = noise';
