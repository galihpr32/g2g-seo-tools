-- ─────────────────────────────────────────────────────────────────────────────
-- Bing Webmaster API integration
--
-- Bing Copilot uses Bing search index, so Bing organic visibility ≈ AI search
-- visibility on Microsoft side. This is the "Phase E" foundation before
-- Frey agent (Phase F) builds direct LLM-query AI visibility tracking.
--
-- Two tables:
--   1. bing_search_data       — daily snapshots of query-level performance
--                               (queries, clicks, impressions, avg_position)
--   2. bing_url_stats         — per-URL crawl + index health (rare changes)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bing_search_data (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_url        text NOT NULL,
  site_slug       text NOT NULL DEFAULT 'g2g',
  snapshot_date   date NOT NULL,
  query           text NOT NULL,
  -- Nullable columns are normalized to '' via the unique index below so the
  -- conflict resolution in upserts works consistently.
  page            text NOT NULL DEFAULT '',
  device          text NOT NULL DEFAULT '',         -- 'desktop' | 'mobile' | 'tablet' | '' (all)
  country         text NOT NULL DEFAULT '',         -- ISO 3166-1 alpha-2, '' = all
  clicks          integer DEFAULT 0,
  impressions     integer DEFAULT 0,
  ctr             numeric(5, 4),                    -- click-through rate (0-1)
  avg_position    numeric(6, 2),
  raw             jsonb,                            -- full Bing response row for audit
  created_at      timestamptz DEFAULT now() NOT NULL,
  updated_at      timestamptz DEFAULT now() NOT NULL
);

-- Unique key for upserts: one row per (owner, site, date, query, page, device, country).
-- Defined as a regular UNIQUE INDEX (Postgres allows expressions here, unlike inline
-- table constraints which only accept plain column lists).
CREATE UNIQUE INDEX IF NOT EXISTS bing_search_data_unique_idx
  ON bing_search_data (owner_user_id, site_slug, snapshot_date, query, page, device, country);

CREATE INDEX IF NOT EXISTS bing_search_data_owner_date_idx
  ON bing_search_data (owner_user_id, site_slug, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS bing_search_data_query_idx
  ON bing_search_data (owner_user_id, site_slug, query, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS bing_search_data_clicks_idx
  ON bing_search_data (owner_user_id, site_slug, snapshot_date DESC, clicks DESC)
  WHERE clicks > 0;

-- ── bing_url_stats: per-URL crawl + index health ──────────────────────────────
CREATE TABLE IF NOT EXISTS bing_url_stats (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_url        text NOT NULL,
  site_slug       text NOT NULL DEFAULT 'g2g',
  page_url        text NOT NULL,
  is_indexed      boolean,
  last_crawled_at timestamptz,
  crawl_status    text,                             -- 'ok' | 'error' | 'redirected' | etc.
  http_code       integer,
  external_links  integer DEFAULT 0,
  internal_links  integer DEFAULT 0,
  raw             jsonb,
  observed_at     timestamptz DEFAULT now() NOT NULL,

  UNIQUE (owner_user_id, site_slug, page_url)
);

CREATE INDEX IF NOT EXISTS bing_url_stats_owner_idx
  ON bing_url_stats (owner_user_id, site_slug, observed_at DESC);

CREATE INDEX IF NOT EXISTS bing_url_stats_indexed_idx
  ON bing_url_stats (owner_user_id, site_slug)
  WHERE is_indexed = false;

-- Verify (run manually):
-- SELECT COUNT(*) FROM bing_search_data;
-- SELECT COUNT(*) FROM bing_url_stats;
