-- Sprint #361 WEEKLY.BOSS.VIEW —
-- Cache table for the Friday KPI "Boss View" preview page. Stores the
-- per-owner latest BossViewPayload snapshot so the preview UI can render
-- instantly without re-running the full GSC + GA4 + tier_serp_snapshots
-- pipeline on every page load.
--
-- Single row per owner (we delete + insert on refresh, not history). The
-- payload shape is defined by BossViewPayload in
-- src/lib/reports/boss-view.ts.

CREATE TABLE IF NOT EXISTS public.friday_kpi_boss_view_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload         jsonb NOT NULL,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT friday_kpi_boss_view_cache_one_per_owner
    UNIQUE (owner_user_id)
);

CREATE INDEX IF NOT EXISTS friday_kpi_boss_view_cache_owner_idx
  ON public.friday_kpi_boss_view_cache (owner_user_id, generated_at DESC);

-- RLS: owner can read/write own row; service_role bypass.
ALTER TABLE public.friday_kpi_boss_view_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "boss_view_owner_select" ON public.friday_kpi_boss_view_cache;
CREATE POLICY "boss_view_owner_select"
  ON public.friday_kpi_boss_view_cache
  FOR SELECT
  USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "boss_view_owner_modify" ON public.friday_kpi_boss_view_cache;
CREATE POLICY "boss_view_owner_modify"
  ON public.friday_kpi_boss_view_cache
  FOR ALL
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

COMMENT ON TABLE public.friday_kpi_boss_view_cache IS
  'Friday KPI Boss View preview cache. One row per owner (latest snapshot only).';
COMMENT ON COLUMN public.friday_kpi_boss_view_cache.payload IS
  'BossViewPayload — see src/lib/reports/boss-view.ts for the TS type.';

NOTIFY pgrst, 'reload schema';
