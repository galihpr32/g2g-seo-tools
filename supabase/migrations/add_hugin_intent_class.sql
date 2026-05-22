-- Sprint CKB.5 — Hugin intent filter integration.
--
-- Add intent_class to hugin_queries so the kit builder can filter out
-- informational-pure long-tail at candidate-pull time (before classifying
-- with a fresh SERP scrape). When NULL, the kit builder treats the query
-- as "needs classification" and runs SERP intent classifier on it.
--
-- Future: a daily cron classifies all NULL rows in batch so the live kit
-- build doesn't pay the latency. For now (Sprint CKB.5) on-demand only.

ALTER TABLE public.hugin_queries
  ADD COLUMN IF NOT EXISTS intent_class text
    CHECK (intent_class IN ('commercial-supportive','commercial-investigation','informational-pure','diy-competing'));

ALTER TABLE public.hugin_queries
  ADD COLUMN IF NOT EXISTS intent_classified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_hugin_queries_intent
  ON public.hugin_queries (owner_user_id, site_slug, intent_class);

COMMENT ON COLUMN public.hugin_queries.intent_class IS
  'Sprint CKB.5 — Classified from SERP top 10. Kit builder filters out informational-pure entries when pulling Hugin candidates. NULL = unclassified yet.';
