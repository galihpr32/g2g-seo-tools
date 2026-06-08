-- Sprint #373 BOSS.VIEW.PUBLISH —
-- Published snapshots of the boss view. Created when the user clicks
-- "Create Report Page" on /reports/friday-kpi/boss-view. Each row is a
-- frozen copy of the boss-view payload at publish time, addressable by
-- slug (e.g. "22-may") so the URL /reports/22-may serves it publicly.
--
-- Multiple owners can publish to the same slug — uniqueness is per
-- (owner_user_id, slug). The PUBLIC GET endpoint reads the most-recent row
-- by slug regardless of owner (whoever published last wins) — fine for our
-- single-org use case. Adjust if multi-tenant becomes a thing.

CREATE TABLE IF NOT EXISTS public.friday_kpi_boss_view_published (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  payload         jsonb NOT NULL,
  generated_at    timestamptz NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT friday_kpi_boss_view_published_owner_slug
    UNIQUE (owner_user_id, slug)
);

CREATE INDEX IF NOT EXISTS friday_kpi_boss_view_published_slug_idx
  ON public.friday_kpi_boss_view_published (slug, published_at DESC);

CREATE INDEX IF NOT EXISTS friday_kpi_boss_view_published_owner_idx
  ON public.friday_kpi_boss_view_published (owner_user_id, published_at DESC);

-- RLS: owner read/write own rows. Public read happens via service_role in
-- the dedicated /api/public/... endpoint (bypasses RLS by design).
ALTER TABLE public.friday_kpi_boss_view_published ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "boss_view_published_owner_select" ON public.friday_kpi_boss_view_published;
CREATE POLICY "boss_view_published_owner_select"
  ON public.friday_kpi_boss_view_published
  FOR SELECT
  USING (owner_user_id = auth.uid());

DROP POLICY IF EXISTS "boss_view_published_owner_modify" ON public.friday_kpi_boss_view_published;
CREATE POLICY "boss_view_published_owner_modify"
  ON public.friday_kpi_boss_view_published
  FOR ALL
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

COMMENT ON TABLE public.friday_kpi_boss_view_published IS
  'Published boss-view snapshots. URL /reports/{slug} serves these read-only without auth (via service_role public API endpoint).';
COMMENT ON COLUMN public.friday_kpi_boss_view_published.slug IS
  'URL slug like "22-may". Unique per (owner, slug); publishing same slug again upserts.';
COMMENT ON COLUMN public.friday_kpi_boss_view_published.payload IS
  'Frozen BossViewPayload at publish time — see src/lib/reports/boss-view.ts.';

NOTIFY pgrst, 'reload schema';
