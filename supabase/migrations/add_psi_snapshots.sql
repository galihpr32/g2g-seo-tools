-- ── PageSpeed Insights snapshots ──────────────────────────────────────────
-- Monthly cron calls Google PSI API for top 20 traffic pages, stores
-- performance / accessibility / best-practices / SEO scores + Core Web
-- Vitals (LCP, INP, CLS).

CREATE TABLE IF NOT EXISTS public.psi_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  page_url        text NOT NULL,
  snapshot_date   date NOT NULL,

  -- Strategy: 'mobile' | 'desktop' (we run mobile by default; mobile = primary
  -- ranking signal per Google's mobile-first indexing)
  strategy        text NOT NULL DEFAULT 'mobile' CHECK (strategy IN ('mobile', 'desktop')),

  -- Lighthouse category scores (0-100)
  performance     int,
  accessibility   int,
  best_practices  int,
  seo             int,

  -- Core Web Vitals — field metrics (CrUX) when available, lab metrics fallback
  lcp_ms          int,                                       -- Largest Contentful Paint (ms)
  inp_ms          int,                                       -- Interaction to Next Paint (ms)
  cls             numeric(5, 3),                             -- Cumulative Layout Shift
  ttfb_ms         int,                                       -- Time To First Byte (ms)
  fcp_ms          int,                                       -- First Contentful Paint (ms)

  -- CWV pass / fail per Google thresholds
  cwv_passed      boolean,                                   -- LCP ≤ 2500ms AND INP ≤ 200ms AND CLS ≤ 0.1

  -- Raw audit summary (top opportunities only)
  top_issues      jsonb,                                      -- [{title, savings_ms?}]
  http_status     int,
  error           text,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotent on (page_url, strategy, snapshot_date)
CREATE UNIQUE INDEX IF NOT EXISTS psi_snapshots_unique_idx
  ON public.psi_snapshots (owner_user_id, site_slug, page_url, strategy, snapshot_date);

CREATE INDEX IF NOT EXISTS psi_snapshots_owner_date_idx
  ON public.psi_snapshots (owner_user_id, site_slug, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS psi_snapshots_failing_idx
  ON public.psi_snapshots (owner_user_id, site_slug, cwv_passed)
  WHERE cwv_passed = false;

ALTER TABLE public.psi_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own PSI snapshots"
  ON public.psi_snapshots FOR SELECT
  USING (auth.uid() = owner_user_id);
