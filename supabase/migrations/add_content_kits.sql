-- Sprint CKB.1 — Content Kit Builder schema.
--
-- A "content kit" is the assembled output of running the kit builder on one
-- cluster-winner keyword. It bundles: a section blueprint (H2 mapped to
-- supporting KWs), FAQ (PAA + selected fan-out), fan-out passages library,
-- keyword placement map, cross-link suggestions, content gap analysis, and
-- schema additions. All of this gets pushed into Bragi as an enriched brief
-- when the user clicks Send to Bragi.
--
-- One kit per (product × primary KW × market). Re-building creates a new row
-- and supersedes the prior (status='superseded') so we keep history for
-- Mimir learning analysis.

CREATE TABLE IF NOT EXISTS public.content_kits (
  id                   uuid           DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id        uuid           NOT NULL,
  product_tier_id      uuid           NOT NULL REFERENCES public.product_tiers(id) ON DELETE CASCADE,
  primary_keyword_id   uuid           REFERENCES public.tier_keywords(id) ON DELETE SET NULL,
  primary_keyword      text           NOT NULL,   -- denormalized for display
  market               text           NOT NULL DEFAULT 'us',
  language             text           NOT NULL DEFAULT 'en',

  -- Status lifecycle: pending → building → ready → sent_to_bragi
  -- (or → failed at any stage)
  -- 'superseded' marks an older kit replaced by a fresh rebuild for same primary.
  status               text           NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','building','ready','failed','sent_to_bragi','superseded')),
  error_message        text,

  -- The actual assembled kit lives here. See src/lib/content-kit/types.ts
  -- for the full shape (sections, faq, fan_out_passages, keyword_placement,
  -- cross_links, gap_analysis, schema_additions, meta).
  kit_data             jsonb,

  -- Telemetry
  build_started_at     timestamptz,
  build_completed_at   timestamptz,
  sent_to_bragi_at     timestamptz,
  brief_id             uuid,                       -- FK lives loose; the brief table is across schema

  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_kits_owner_product
  ON public.content_kits (owner_user_id, product_tier_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_kits_owner_status
  ON public.content_kits (owner_user_id, status, created_at DESC);

-- Find the latest non-superseded kit for a (product × primary_keyword) pair
CREATE INDEX IF NOT EXISTS idx_content_kits_primary_lookup
  ON public.content_kits (owner_user_id, product_tier_id, primary_keyword_id, created_at DESC)
  WHERE status <> 'superseded';

COMMENT ON TABLE public.content_kits IS
  'Sprint CKB.1 — Content Kit Builder output. One row per kit build attempt. Re-builds supersede prior rows (status=superseded) for history.';

ALTER TABLE public.content_kits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners read their own kits"
  ON public.content_kits FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid());

CREATE POLICY "Owners write their own kits"
  ON public.content_kits FOR ALL
  TO authenticated
  USING (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────────────
-- Per-KW intent classification (used by kit builder filter + Hugin filter)
-- ───────────────────────────────────────────────────────────────────────────
-- Categories:
--   'commercial-supportive'    — SERP dominated by ecommerce/marketplace.
--                                 Safe to target as H2 section in product page.
--   'commercial-investigation' — Mixed SERP (compare/review/best-of).
--                                 Include but with strong CTA bridge.
--   'informational-pure'       — SERP dominated by blog/wiki/forum.
--                                 Skip or relegate to FAQ-only.
--   'diy-competing'            — SERP dominated by tutorial/farming guides.
--                                 Either skip OR use counter-content treatment.
--   NULL                       — not yet classified.

ALTER TABLE public.tier_keywords
  ADD COLUMN IF NOT EXISTS intent_class text
    CHECK (intent_class IN ('commercial-supportive','commercial-investigation','informational-pure','diy-competing'));

ALTER TABLE public.tier_keywords
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

COMMENT ON COLUMN public.tier_keywords.intent_class IS
  'Sprint CKB.1 — Classified from SERP top 10 composition. Used by kit builder to filter candidates and by Hugin to auto-skip pure-info long-tail.';
