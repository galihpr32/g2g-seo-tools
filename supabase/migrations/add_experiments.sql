-- ── Experiments (Start / Stop / Continue tracker) ───────────────────────────
-- Monthly experimentation framework. Each row = one initiative the team is
-- testing. Lifecycle:
--   start    → newly proposed this period (the user just kicked it off)
--   continue → carried forward from a prior period, still being measured
--   stop     → ended this period; decision_notes capture what we learned
--
-- Per-site by site_slug so G2G and OffGamers don't share strategies. Linkable
-- to keywords/pages so the monthly report can pull metric snapshots
-- automatically (e.g. "added FAQ to /categories/wow-gold; here's avg position
-- since launch").

CREATE TABLE IF NOT EXISTS public.experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',

  -- The idea itself
  title           text NOT NULL,
  hypothesis      text,                     -- why we think this will help
  category        text,                     -- e.g. 'on-page', 'content', 'technical', 'links'
  source          text,                     -- 'mimir' | 'manual' — provenance for the dashboard
  source_context  jsonb,                    -- when source='mimir', stores the data Mimir referenced

  -- Lifecycle
  status          text NOT NULL DEFAULT 'start'
                  CHECK (status IN ('start','continue','stop')),
  period_started  text NOT NULL,            -- 'YYYY-MM' the experiment first appeared
  period_ended    text,                     -- 'YYYY-MM' when stopped (null while active)

  -- Success criteria
  success_metric  text,                     -- free-form e.g. "Avg pos for top 5 keywords improves by 3+"
  baseline_value  numeric,                  -- starting metric (filled at creation)
  target_value    numeric,                  -- target for success
  current_value   numeric,                  -- updated each review cycle

  -- Optional links — when populated the monthly report pulls automatic
  -- metric snapshots (e.g. ranking deltas for the linked keywords from
  -- keyword_ranking_history).
  linked_keywords text[] NOT NULL DEFAULT '{}',
  linked_pages    text[] NOT NULL DEFAULT '{}',

  -- Captured when status flips to 'stop' — what we learned
  decision_notes  text,
  outcome         text                       -- 'success' | 'partial' | 'failure' | 'inconclusive'
                  CHECK (outcome IS NULL OR outcome IN ('success','partial','failure','inconclusive')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Hot-path: Kanban board "give me everything for this site, by status, newest first"
CREATE INDEX IF NOT EXISTS experiments_site_status_idx
  ON public.experiments (owner_user_id, site_slug, status, updated_at DESC);

-- Period scope: monthly report queries by period_started / period_ended
CREATE INDEX IF NOT EXISTS experiments_period_idx
  ON public.experiments (owner_user_id, site_slug, period_started, period_ended);

ALTER TABLE public.experiments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own experiments"
  ON public.experiments FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

-- updated_at maintenance — touched on every UPDATE
CREATE OR REPLACE FUNCTION public.touch_experiments_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS experiments_touch_updated_at ON public.experiments;
CREATE TRIGGER experiments_touch_updated_at
  BEFORE UPDATE ON public.experiments
  FOR EACH ROW EXECUTE FUNCTION public.touch_experiments_updated_at();

-- ── Mimir conversation log ───────────────────────────────────────────────────
-- Mimir is the experiment ideator agent. Conversations are persisted so the
-- chat panel on /experiments retains context across sessions and so the user
-- can revisit prior idea-generation runs.

CREATE TABLE IF NOT EXISTS public.mimir_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  title           text NOT NULL DEFAULT 'New conversation',
  messages        jsonb NOT NULL DEFAULT '[]',   -- [{role, content, ts, tool_calls?}]
  pinned          boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mimir_conversations_owner_site_idx
  ON public.mimir_conversations (owner_user_id, site_slug, updated_at DESC);

ALTER TABLE public.mimir_conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own Mimir conversations"
  ON public.mimir_conversations FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE OR REPLACE FUNCTION public.touch_mimir_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mimir_conversations_touch_updated_at ON public.mimir_conversations;
CREATE TRIGGER mimir_conversations_touch_updated_at
  BEFORE UPDATE ON public.mimir_conversations
  FOR EACH ROW EXECUTE FUNCTION public.touch_mimir_updated_at();
