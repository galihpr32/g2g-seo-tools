-- ── category_prompts ──────────────────────────────────────────────────────────
-- Stores editable Master Prompt List per owner.
-- When empty, the application falls back to the hardcoded TS defaults.

CREATE TABLE IF NOT EXISTS public.category_prompts (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  category_key           text        NOT NULL,   -- 'accounts' | 'coins' | 'boosting' | etc.
  category_name          text        NOT NULL,   -- display name
  icon                   text,

  -- Prompt fields (mirrors CategoryTemplate in g2g-category-prompts.ts)
  url_patterns           text[],
  h1_template            text,
  meta_title_template    text,
  meta_description_guide text,
  keyword_rules          text,
  writing_rules          text,
  faq_focus              text,
  sections               jsonb,      -- [{ subheading: string, instructions: string }]

  is_active              boolean     NOT NULL DEFAULT true,

  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now(),

  UNIQUE (owner_user_id, category_key)
);

ALTER TABLE public.category_prompts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own category prompts"
  ON public.category_prompts FOR ALL TO authenticated
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

CREATE INDEX IF NOT EXISTS category_prompts_owner
  ON public.category_prompts (owner_user_id);
