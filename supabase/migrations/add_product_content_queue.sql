-- ── product_content_queue ─────────────────────────────────────────────────────
-- Tracks auto-generated product content from Google Sheets pipeline.
-- Stores both the generated content (DB backup) and upload status to CMS.

CREATE TABLE IF NOT EXISTS public.product_content_queue (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Source (from Google Sheet)
  relation_id      text        NOT NULL,
  product_name     text        NOT NULL,
  category         text,
  url              text,
  sheet_row        integer,    -- row number in the source sheet
  -- Generated content (backup)
  meta_title       text,
  meta_description text,
  meta_keywords    text,
  marketing_title  text,
  marketing_description text,  -- HTML
  -- Status tracking
  status           text        NOT NULL DEFAULT 'pending',
  -- pending | generating | generated | uploading | uploaded | failed
  cms_seo_status   text,       -- ok | error
  cms_seo_error    text,
  cms_mkt_status   text,       -- ok | error
  cms_mkt_error    text,
  -- Timestamps
  generated_at     timestamptz,
  uploaded_at      timestamptz,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  -- Prevent duplicate entries per product
  UNIQUE (owner_user_id, relation_id)
);

ALTER TABLE public.product_content_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own product queue"
  ON public.product_content_queue FOR ALL TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  )
  WITH CHECK (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  );

CREATE INDEX IF NOT EXISTS product_content_queue_owner
  ON public.product_content_queue (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_content_queue_status
  ON public.product_content_queue (owner_user_id, status);

-- ── product_sheet_config ──────────────────────────────────────────────────────
-- Stores the Google Sheet URL + settings per workspace

CREATE TABLE IF NOT EXISTS public.product_sheet_config (
  owner_user_id   uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  spreadsheet_id  text        NOT NULL,   -- Google Sheet ID
  sheet_name      text        NOT NULL DEFAULT 'Sheet1',
  auto_generate   boolean     NOT NULL DEFAULT true,
  auto_upload     boolean     NOT NULL DEFAULT false,  -- require manual review before upload
  last_synced_at  timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.product_sheet_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own sheet config"
  ON public.product_sheet_config FOR ALL TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  )
  WITH CHECK (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  );
