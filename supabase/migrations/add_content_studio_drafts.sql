-- ── content_studio_drafts ─────────────────────────────────────────────────────
-- Stores Content Studio drafts — saved by writer team, linked to owner.

CREATE TABLE IF NOT EXISTS public.content_studio_drafts (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Topic / context
  title           text         NOT NULL,
  topic           text         NOT NULL,
  game_name       text,
  steam_appid     integer,
  -- Content config
  content_type    text         NOT NULL DEFAULT 'blog_post',  -- blog_post | landing_page | category_page | guide | listicle
  tone            text         NOT NULL DEFAULT 'informative', -- informative | persuasive | casual | professional
  language        text         NOT NULL DEFAULT 'en',
  target_audience text,
  word_count      integer      DEFAULT 1000,
  -- Keywords
  target_keywords text[]       DEFAULT '{}',
  -- Images
  image_urls      text[]       DEFAULT '{}',
  -- Generated content
  content         text,        -- full markdown content
  meta_title      text,
  meta_description text,
  status          text         NOT NULL DEFAULT 'draft',  -- draft | generating | done
  -- Meta
  created_at      timestamptz  DEFAULT now(),
  updated_at      timestamptz  DEFAULT now()
);

ALTER TABLE public.content_studio_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own drafts"
  ON public.content_studio_drafts FOR ALL TO authenticated
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

CREATE INDEX IF NOT EXISTS content_studio_drafts_owner
  ON public.content_studio_drafts (owner_user_id, created_at DESC);
