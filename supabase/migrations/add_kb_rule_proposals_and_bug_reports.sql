-- ── Sprint 1: KB feedback loop + bug reports ───────────────────────────────
-- Two unrelated additions packaged together because they're both small and
-- both ship in Sprint 1.

-- ============================================================
-- 1. kb_rule_proposals — the feedback loop foundation
-- ============================================================
--
-- Every channel that produces "we learned something" feeds into this single
-- queue:
--   • Monthly KB extraction cron (winners vs losers brief patterns)
--   • "Promote to KB" button on brief detail (writer flags a useful pattern)
--   • "Promote to KB" button on experiment-stop form (Head codifies a win)
--
-- Status flow:
--   pending → approved (and optionally `applied` once written into a KB item)
--           → rejected (with optional reason)
--
-- On approval the application step writes either to an EXISTING
-- knowledge_base_items.data (append to dos/donts/writing_rules array etc.)
-- or creates a new item. We don't auto-apply on approval — the human chooses
-- the target so we don't pollute brand/category/platform items with mismatched
-- content.

CREATE TABLE IF NOT EXISTS public.kb_rule_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',

  -- The proposal itself
  title           text NOT NULL,
  rule_text       text NOT NULL,                 -- the actual rule (1-3 sentences)
  pattern_kind    text NOT NULL                  -- what TYPE of learning
                  CHECK (pattern_kind IN ('winning','cautionary','exclusion','tone','format','generic')),

  -- Where the proposal came from (drives the UI grouping)
  source          text NOT NULL                  -- 'cron_extractor' | 'brief_promote' | 'experiment_promote' | 'manual'
                  CHECK (source IN ('cron_extractor','brief_promote','experiment_promote','manual')),
  source_brief_ids   uuid[] NOT NULL DEFAULT '{}',  -- briefs that informed this (winners or the source brief)
  source_loser_ids   uuid[] NOT NULL DEFAULT '{}',  -- losers contrasted against (extractor only)
  source_experiment_id uuid,                       -- when source='experiment_promote'

  -- Confidence + suggested target (extractor outputs these; manual sources may leave null)
  confidence            int     CHECK (confidence IS NULL OR (confidence BETWEEN 1 AND 5)),
  suggested_kb_item_id  uuid REFERENCES public.knowledge_base_items(id) ON DELETE SET NULL,
  suggested_kb_field    text,                    -- e.g. 'dos','donts','writing_rules','notes'

  -- Status flow
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','applied')),
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  review_notes      text,                       -- why approved/rejected, free-form

  -- After approval, when the rule is actually written into a KB item:
  applied_kb_item_id  uuid REFERENCES public.knowledge_base_items(id) ON DELETE SET NULL,
  applied_kb_field    text,
  applied_at          timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Hot-path: review queue for site_slug, ordered by newest pending
CREATE INDEX IF NOT EXISTS kb_rule_proposals_review_idx
  ON public.kb_rule_proposals (owner_user_id, site_slug, status, created_at DESC);

-- Source-specific lookups (e.g. "show me proposals derived from this brief")
CREATE INDEX IF NOT EXISTS kb_rule_proposals_source_brief_idx
  ON public.kb_rule_proposals USING gin (source_brief_ids);

ALTER TABLE public.kb_rule_proposals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own kb_rule_proposals"
  ON public.kb_rule_proposals FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE OR REPLACE FUNCTION public.touch_kb_rule_proposals_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS kb_rule_proposals_touch_updated_at ON public.kb_rule_proposals;
CREATE TRIGGER kb_rule_proposals_touch_updated_at
  BEFORE UPDATE ON public.kb_rule_proposals
  FOR EACH ROW EXECUTE FUNCTION public.touch_kb_rule_proposals_updated_at();


-- ============================================================
-- 2. bug_reports — in-app feedback / issue intake
-- ============================================================
--
-- Floating "🐛 Report" button on every page submits here. Galih (Head)
-- triages from /feedback. Replaces ad-hoc Slack DMs / external trackers.

CREATE TABLE IF NOT EXISTS public.bug_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text,                              -- which site was active when reported (best-effort)

  title           text NOT NULL,
  description     text NOT NULL,
  page_url        text,                              -- captured at submit time
  severity        text NOT NULL DEFAULT 'medium'
                  CHECK (severity IN ('low','medium','high')),

  -- Optional attachments — for now we just store an array of public URLs.
  -- Later we can swap to Supabase Storage signed URLs.
  attachments     text[] NOT NULL DEFAULT '{}',

  -- Status flow
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','in_progress','resolved','wont_fix')),
  resolution_notes text,
  triaged_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  triaged_at      timestamptz,

  -- Free-form thread of replies (jsonb so we don't need a separate table for v1)
  replies         jsonb NOT NULL DEFAULT '[]',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bug_reports_status_idx
  ON public.bug_reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS bug_reports_submitter_idx
  ON public.bug_reports (submitter_id, created_at DESC);

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;

-- Submitters can SEE their own reports + all replies
CREATE POLICY "Submitters see own bug_reports"
  ON public.bug_reports FOR SELECT
  USING (auth.uid() = submitter_id);

-- Submitters can INSERT new reports (one of the few user-driven write paths)
CREATE POLICY "Submitters insert own bug_reports"
  ON public.bug_reports FOR INSERT
  WITH CHECK (auth.uid() = submitter_id);

-- Triage (Head) — service role does everything else; no separate role yet.
-- Service-client routes (/api/feedback PATCH) handle status changes.
-- Skipping a "head can update any" policy for now — service role bypasses RLS.

CREATE OR REPLACE FUNCTION public.touch_bug_reports_updated_at()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bug_reports_touch_updated_at ON public.bug_reports;
CREATE TRIGGER bug_reports_touch_updated_at
  BEFORE UPDATE ON public.bug_reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_bug_reports_updated_at();
