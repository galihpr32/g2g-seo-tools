-- ── outreach_prospects ────────────────────────────────────────────────────────
-- Tracks guestpost outreach pipeline: discovery → contacted → published → monitored

CREATE TABLE IF NOT EXISTS public.outreach_prospects (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Site info
  domain           text        NOT NULL,
  authority_score  integer,    -- SEMrush Authority Score (0-100)
  organic_traffic  integer,    -- estimated monthly organic traffic
  organic_keywords integer,
  site_language    text,

  -- Outreach details
  contact_name     text,
  contact_email    text,
  topic            text,       -- proposed article/post topic
  target_url       text,       -- G2G page we want the backlink to point to
  anchor_text      text,       -- desired anchor text

  -- Result
  published_url    text,       -- URL of the live guestpost
  published_date   date,

  -- Pipeline status
  status           text        NOT NULL DEFAULT 'prospecting',
  -- prospecting | contacted | negotiating | accepted | published | rejected

  -- Notes + follow-up
  notes            text,
  follow_up_date   date,

  -- Discovery metadata
  source_keyword   text,       -- keyword used to discover this domain
  discovered_via   text        DEFAULT 'semrush',  -- semrush | manual

  -- Monitor
  backlink_live    boolean,    -- null = not checked yet
  last_checked_at  timestamptz,
  check_error      text,

  -- Timestamps
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),

  UNIQUE (owner_user_id, domain)
);

ALTER TABLE public.outreach_prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own outreach prospects"
  ON public.outreach_prospects FOR ALL TO authenticated
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

CREATE INDEX IF NOT EXISTS outreach_prospects_owner_status
  ON public.outreach_prospects (owner_user_id, status);
CREATE INDEX IF NOT EXISTS outreach_prospects_owner_created
  ON public.outreach_prospects (owner_user_id, created_at DESC);
