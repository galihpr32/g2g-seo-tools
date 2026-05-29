-- ── Hermod v2: domain scoring cache ──────────────────────────────────────────
-- Replaces the SEMrush dependency that hit 403 / quota limits. New stack:
--   • DataForSEO SERP top 10 for the keyword (already paid)
--   • FireCrawl scrape per domain (already paid; 7-day cache reused)
--   • Claude Haiku evaluator → 5-dim score + outreach angle
--
-- Each domain gets one row per workspace, valid for 14 days. After expiry the
-- evaluator re-scrapes + re-scores so we don't act on stale signals about a
-- site that may have changed (rebrand, gone dark, etc.).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.outreach_domain_scores (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  domain          text         NOT NULL,
  source_keyword  text,                                -- the keyword that surfaced this domain (latest)

  -- Five sub-scores from Haiku, each 0-10
  niche_score      numeric(3,1)  NOT NULL DEFAULT 0,    -- gaming-related?
  quality_score    numeric(3,1)  NOT NULL DEFAULT 0,    -- well-written + recent?
  outreach_score   numeric(3,1)  NOT NULL DEFAULT 0,    -- has "write for us"? open?
  audience_score   numeric(3,1)  NOT NULL DEFAULT 0,    -- gamer audience?
  trust_score      numeric(3,1)  NOT NULL DEFAULT 0,    -- not spam/PBN?

  -- Weighted overall — populated by app code (kept as numeric column for
  -- index sort / filter rather than recomputing in queries).
  overall_score    numeric(4,2)  NOT NULL DEFAULT 0,

  -- Hermod-readable signals
  outreach_angle      text,
  has_write_for_us    boolean      DEFAULT false,
  contact_email       text,
  notes               text,                              -- Haiku's free-form rationale

  -- Pages actually scraped (for traceability + future re-eval shortcuts)
  scraped_urls        text[]       DEFAULT '{}',

  -- TTL
  evaluated_at        timestamptz  NOT NULL DEFAULT now(),
  expires_at          timestamptz  NOT NULL DEFAULT (now() + interval '14 days'),

  UNIQUE (owner_user_id, domain)
);

CREATE INDEX IF NOT EXISTS outreach_domain_scores_owner_score
  ON public.outreach_domain_scores (owner_user_id, overall_score DESC);

CREATE INDEX IF NOT EXISTS outreach_domain_scores_expires
  ON public.outreach_domain_scores (expires_at);

ALTER TABLE public.outreach_domain_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can read domain scores"
  ON public.outreach_domain_scores FOR SELECT TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid())
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- Brief-mode column on outreach_prospects — queue items as pending_approval
-- before the user clicks "Send" on the Outreach page. Existing behaviour
-- (auto-queue) still works: rows without this flag default to active.

ALTER TABLE public.outreach_prospects
  ADD COLUMN IF NOT EXISTS approval_required boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_for_send_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_for_send_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS outreach_prospects_pending_approval
  ON public.outreach_prospects (owner_user_id, approval_required)
  WHERE approval_required = true AND approved_for_send_at IS NULL;
