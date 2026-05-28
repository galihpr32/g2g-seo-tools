-- Sprint FRIDAY.KPI.GRAPH.2 — manual action plan overrides per week.
--
-- The synthesizer generates 3 auto-actions from Mimir + Forseti + Hugin + Loki
-- signals each Friday. If lo edit one via the UI, the override stored here
-- replaces the auto-generated one for that week × brand × index. Re-running
-- the synth doesn't clobber overrides (only fills empty slots).

CREATE TABLE IF NOT EXISTS public.friday_kpi_action_overrides (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id   uuid        NOT NULL,
  week_iso        text        NOT NULL,             -- '2026-W21' format
  brand           text        NOT NULL,             -- 'g2g' | 'offgamers'
  action_index    int         NOT NULL CHECK (action_index BETWEEN 0 AND 9),
  action_text     text        NOT NULL,
  edited_by       uuid        NOT NULL,
  edited_at       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT friday_kpi_action_overrides_unique
    UNIQUE (owner_user_id, week_iso, brand, action_index)
);

CREATE INDEX IF NOT EXISTS idx_friday_kpi_action_overrides_lookup
  ON public.friday_kpi_action_overrides (owner_user_id, week_iso, brand);

COMMENT ON TABLE public.friday_kpi_action_overrides
  IS 'Sprint FRIDAY.KPI.GRAPH.2 — manual edits to the auto-synthesized Friday KPI action plan. Per (week × brand × slot). Survives re-renders.';

ALTER TABLE public.friday_kpi_action_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their own action overrides"
  ON public.friday_kpi_action_overrides FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid());

CREATE POLICY "Owners write their own action overrides"
  ON public.friday_kpi_action_overrides FOR ALL
  TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
