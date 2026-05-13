-- ── Brief Review Feedback — HITL training data capture ────────────────────
-- Every edit a human reviewer makes to a Tier 1 (or any) brief becomes a
-- training signal. This table logs section-level diffs + a reviewer-supplied
-- "why" tag. The weekly learning aggregator scans these rows, clusters by
-- reason, and proposes KB rules + Tyr threshold adjustments.
--
-- Architecture (per Galih's design):
--   1. Tier 1 manual review continues — reviewer is the HITL trainer
--   2. Every edit captured per section (intro, sections[0..N], faqs, meta_title, …)
--   3. Reviewer optionally tags a short "why" — Haiku classifier buckets it
--   4. Weekly aggregator generates kb_rule_proposals (existing table)
--   5. Galih reviews proposals → 1-click approve/reject
--   6. Approved rules update KB / Mimir / Tyr config
--   7. Improved AI quality → lower threshold for non-Tier-1 → eventually Tier 1

CREATE TABLE IF NOT EXISTS public.brief_review_feedback (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  brief_id        uuid NOT NULL REFERENCES public.seo_content_briefs(id) ON DELETE CASCADE,
  /** Who reviewed. NULL if not yet resolvable (system import). */
  reviewer_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  /** Which section was edited.
   *  Values: 'meta_title', 'meta_description', 'h1', 'intro',
   *  'section:0' .. 'section:7', 'faq:0' .. 'faq:6', 'outline', 'other'. */
  section_label   text NOT NULL,

  /** Original AI-generated text (snapshot at brief creation). May be null
   *  for legacy briefs that pre-date capture. */
  ai_version      text,
  /** Human-approved text (current value after review). */
  human_version   text,
  /** Concise edit summary — populated by Haiku ('shortened intro by 40%',
   *  'replaced product feature list with safety angle'). */
  diff_summary    text,

  /** Reviewer-supplied freeform reason (optional, captured via modal). */
  reason_freetext text,
  /** Haiku-classified bucket. Set by classifier job. */
  reason_classified text
                  CHECK (reason_classified IS NULL OR reason_classified IN (
                    'tone', 'factuality', 'structure', 'length',
                    'brand_voice', 'forbidden_claim', 'keyword_intent',
                    'completeness', 'category_template', 'other'
                  )),

  /** Edit magnitude — for prioritising aggregator focus. */
  severity        text NOT NULL DEFAULT 'minor'
                  CHECK (severity IN ('minor','major','critical')),

  /** When this feedback row was captured (= when human saved the brief). */
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brief_review_feedback_owner_site_idx
  ON public.brief_review_feedback (owner_user_id, site_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS brief_review_feedback_brief_idx
  ON public.brief_review_feedback (brief_id);

CREATE INDEX IF NOT EXISTS brief_review_feedback_reason_idx
  ON public.brief_review_feedback (owner_user_id, reason_classified, created_at DESC)
  WHERE reason_classified IS NOT NULL;

-- Partial index for the aggregator hot path (find rows with NULL classification)
CREATE INDEX IF NOT EXISTS brief_review_feedback_unclassified_idx
  ON public.brief_review_feedback (owner_user_id, created_at)
  WHERE reason_classified IS NULL AND reason_freetext IS NOT NULL;

ALTER TABLE public.brief_review_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own review feedback"
  ON public.brief_review_feedback FOR SELECT
  USING (auth.uid() = owner_user_id);

CREATE POLICY "Service role manages feedback"
  ON public.brief_review_feedback FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ── seo_content_briefs: persistent AI-original snapshot ───────────────────
-- We need to remember what Bragi originally produced, so we can diff against
-- the human-edited version every time. Without this, the FIRST edit is the
-- only one we can ever diff — subsequent saves would compare against the
-- already-human-edited version and miss the original signal.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS ai_original_draft     text,
  ADD COLUMN IF NOT EXISTS ai_original_meta      jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_original_captured_at timestamptz;

COMMENT ON COLUMN public.seo_content_briefs.ai_original_draft IS
  'Snapshot of Bragi-generated content_draft at first save. Used to diff against human edits for review-feedback capture (Sprint LEARN.1).';

-- ── Extend kb_rule_proposals.source enum to include review_feedback ───────
-- The aggregator generates proposals with this source so the existing
-- /knowledge-base/proposals UI can route them through the same approval flow.

ALTER TABLE public.kb_rule_proposals
  DROP CONSTRAINT IF EXISTS kb_rule_proposals_source_check;

ALTER TABLE public.kb_rule_proposals
  ADD CONSTRAINT kb_rule_proposals_source_check
  CHECK (source IN ('cron_extractor','brief_promote','experiment_promote','manual','review_feedback'));

COMMENT ON TABLE public.brief_review_feedback IS
  'HITL training data: every edit a reviewer makes to a brief becomes a training signal. Aggregator scans weekly + proposes KB rules + Tyr threshold tuning.';
