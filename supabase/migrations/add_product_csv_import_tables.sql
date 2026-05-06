-- ── Product CSV import audit + brand-category KB learning ────────────────────
-- Tables that power the new CSV import/export flow on the Product Content
-- page. Two purposes:
--
--   product_content_imports          — audit trail per import (rollback ready)
--   product_brand_category_patterns  — frequency table of (brand → category)
--                                      so the UI can suggest/validate new entries
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_content_imports (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  source          text         NOT NULL,                    -- 'csv' | 'sheet' | 'manual'
  source_file     text,                                     -- file name or sheet tab
  imported_at     timestamptz  NOT NULL DEFAULT now(),
  imported_by     uuid         REFERENCES auth.users(id) ON DELETE SET NULL,

  rows_total      integer      NOT NULL DEFAULT 0,
  rows_new        integer      NOT NULL DEFAULT 0,
  rows_updated    integer      NOT NULL DEFAULT 0,
  rows_skipped    integer      NOT NULL DEFAULT 0,
  rows_conflicts  integer      NOT NULL DEFAULT 0,

  -- Snapshot of the import payload so we can show diffs later or roll back
  -- Shape: [{ relation_id, action: 'inserted' | 'updated' | 'skipped' | 'conflict_resolved', changes: {…} }]
  changes_summary jsonb        NOT NULL DEFAULT '[]'::jsonb,

  notes           text
);

CREATE INDEX IF NOT EXISTS product_content_imports_owner_date
  ON public.product_content_imports (owner_user_id, imported_at DESC);

ALTER TABLE public.product_content_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can read imports"
  ON public.product_content_imports FOR SELECT TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  );

CREATE POLICY "owner can insert imports"
  ON public.product_content_imports FOR INSERT TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  );


-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_brand_category_patterns (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  brand_name      text         NOT NULL,                  -- raw brand name as entered
  brand_norm      text         NOT NULL,                  -- normalised for lookup (lowercase + strip punctuation)
  category        text         NOT NULL,
  occurrence_count integer     NOT NULL DEFAULT 1,        -- bumped each time we see this combo
  first_seen_at   timestamptz  NOT NULL DEFAULT now(),
  last_seen_at    timestamptz  NOT NULL DEFAULT now(),

  UNIQUE (owner_user_id, brand_norm, category)
);

CREATE INDEX IF NOT EXISTS product_brand_category_patterns_owner_brand
  ON public.product_brand_category_patterns (owner_user_id, brand_norm);

ALTER TABLE public.product_brand_category_patterns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can read brand patterns"
  ON public.product_brand_category_patterns FOR SELECT TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  );

CREATE POLICY "owner can manage brand patterns"
  ON public.product_brand_category_patterns FOR ALL TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  )
  WITH CHECK (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  );
