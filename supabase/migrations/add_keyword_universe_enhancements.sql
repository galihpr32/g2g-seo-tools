-- Migration: keyword universe enhancements for Saga (curator agent).
--
-- Adds the missing pieces needed for Saga to operate on keyword_maps +
-- keyword_map_clusters: archive lifecycle, decay-detection metrics, brief
-- linkage, and supporting indexes.

-- ── 1. keyword_map_clusters: extend status to include 'archived' ────────────
-- Original schema had no CHECK on status, but the documented enum was
-- not_started → writing → review → published → tracking. We add 'archived'
-- as a graceful exit and add an explicit CHECK so invalid values are
-- rejected upfront.
UPDATE keyword_map_clusters
   SET status = 'not_started'
 WHERE status IS NULL
    OR status NOT IN ('not_started', 'writing', 'review', 'published', 'tracking', 'archived');

ALTER TABLE keyword_map_clusters
  DROP CONSTRAINT IF EXISTS keyword_map_clusters_status_check;

ALTER TABLE keyword_map_clusters
  ADD CONSTRAINT keyword_map_clusters_status_check
  CHECK (status IN ('not_started', 'writing', 'review', 'published', 'tracking', 'archived'));

-- ── 2. keyword_map_clusters: decay-detection columns ────────────────────────
ALTER TABLE keyword_map_clusters
  ADD COLUMN IF NOT EXISTS last_action_at      timestamptz,    -- last time any agent_action referenced this cluster
  ADD COLUMN IF NOT EXISTS gsc_clicks_30d      integer,        -- populated by gsc-daily cron (0 ⇒ no traffic, NULL ⇒ no data)
  ADD COLUMN IF NOT EXISTS gsc_impressions_30d integer,        -- same
  ADD COLUMN IF NOT EXISTS gsc_metrics_at      timestamptz;    -- when gsc_* columns were last refreshed

-- ── 3. keyword_map_clusters: link to seo_content_briefs ─────────────────────
-- A cluster can have one brief at a time. When the brief is deleted we
-- preserve the cluster and just nullify the link.
ALTER TABLE keyword_map_clusters
  ADD COLUMN IF NOT EXISTS brief_id uuid REFERENCES seo_content_briefs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS keyword_map_clusters_brief_idx
  ON keyword_map_clusters (brief_id)
  WHERE brief_id IS NOT NULL;

-- ── 4. Indexes for Saga's recurring queries ────────────────────────────────-
-- "find archive candidates": status='not_started' AND last_action_at < cutoff
CREATE INDEX IF NOT EXISTS keyword_map_clusters_decay_idx
  ON keyword_map_clusters (status, last_action_at)
  WHERE status IN ('not_started', 'tracking');

-- "find clusters by source for coverage analysis"
CREATE INDEX IF NOT EXISTS keyword_map_clusters_source_idx
  ON keyword_map_clusters (owner_user_id, source);

-- ── 5. keyword_maps: add archive status ────────────────────────────────────-
-- A whole topic can also be archived (e.g. game shut down, market exit).
UPDATE keyword_maps
   SET status = 'planning'
 WHERE status IS NULL
    OR status NOT IN ('planning', 'in_progress', 'published', 'archived');

ALTER TABLE keyword_maps
  DROP CONSTRAINT IF EXISTS keyword_maps_status_check;

ALTER TABLE keyword_maps
  ADD CONSTRAINT keyword_maps_status_check
  CHECK (status IN ('planning', 'in_progress', 'published', 'archived'));

-- ── 6. keyword_maps: last activity timestamp (denormalized for fast list) ──
ALTER TABLE keyword_maps
  ADD COLUMN IF NOT EXISTS last_cluster_activity_at timestamptz;

CREATE INDEX IF NOT EXISTS keyword_maps_active_idx
  ON keyword_maps (owner_user_id, status, last_cluster_activity_at DESC NULLS LAST)
  WHERE status IN ('planning', 'in_progress', 'published');

-- ── 7. Auto-update keyword_maps.updated_at on cluster change (optional) ─────
-- Trigger fires when any cluster changes, bubbling timestamp up so the
-- topic-level "freshness" reflects cluster activity. Used by Saga's
-- coverage report to sort topics by recency.
CREATE OR REPLACE FUNCTION bump_keyword_map_activity()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE keyword_maps
     SET last_cluster_activity_at = now(),
         updated_at               = now()
   WHERE id = COALESCE(NEW.map_id, OLD.map_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS keyword_map_clusters_bump_parent ON keyword_map_clusters;
CREATE TRIGGER keyword_map_clusters_bump_parent
  AFTER INSERT OR UPDATE OR DELETE ON keyword_map_clusters
  FOR EACH ROW EXECUTE FUNCTION bump_keyword_map_activity();
