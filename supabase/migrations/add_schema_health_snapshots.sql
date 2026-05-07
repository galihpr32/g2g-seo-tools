-- ── Schema health snapshots ────────────────────────────────────────────────
-- Weekly cron fetches each top page's HTML, extracts JSON-LD blocks,
-- validates against schema.org expectations. Result lands here for UI to
-- show trend over time + flag broken pages.

CREATE TABLE IF NOT EXISTS public.schema_health_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  page_url        text NOT NULL,
  snapshot_date   date NOT NULL,

  -- Per-snapshot data
  has_jsonld         boolean NOT NULL DEFAULT false,
  jsonld_count       int     NOT NULL DEFAULT 0,           -- count of <script type="application/ld+json"> blocks
  schema_types       text[]  NOT NULL DEFAULT '{}',         -- e.g. ['Product','BreadcrumbList']
  validation_errors  text[]  NOT NULL DEFAULT '{}',         -- list of human-readable error messages
  validity_score     int     NOT NULL DEFAULT 0,            -- 0-100 (100=clean, 0=missing/broken)
  http_status        int,
  raw_jsonld         jsonb,                                  -- full extracted blocks for debug

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotent upserts on (page_url, snapshot_date)
CREATE UNIQUE INDEX IF NOT EXISTS schema_health_unique_idx
  ON public.schema_health_snapshots (owner_user_id, site_slug, page_url, snapshot_date);

-- Hot-path: "show me trend for this page" + "show me broken schema NOW"
CREATE INDEX IF NOT EXISTS schema_health_owner_date_idx
  ON public.schema_health_snapshots (owner_user_id, site_slug, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS schema_health_broken_idx
  ON public.schema_health_snapshots (owner_user_id, site_slug, validity_score)
  WHERE validity_score < 70;

ALTER TABLE public.schema_health_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own schema snapshots"
  ON public.schema_health_snapshots FOR SELECT
  USING (auth.uid() = owner_user_id);
