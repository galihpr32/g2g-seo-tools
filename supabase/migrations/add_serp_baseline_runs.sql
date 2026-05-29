-- ── Chunked SERP baseline runs ────────────────────────────────────────────
-- Tracks long-running SERP baseline jobs so they can survive Vercel's 300s
-- function timeout. Each "run" represents one user clicking "Refresh SERP
-- baseline" on /priority-products. The run is split into chunks of
-- N (kw × market) pairs; each tick processes one chunk and updates progress.
--
-- Lifecycle:
--   1. POST /run-baseline/start    → creates row with status='pending', enqueues all pairs
--   2. POST /run-baseline/tick     → processes next CHUNK_SIZE pairs, updates counters
--   3. UI polls /run-baseline/status?id=X every N seconds until status='done'
--
-- Idempotency: tier_serp_snapshots UNIQUE(owner, product, keyword, market, date)
-- means re-running the same pair on the same day is a no-op upsert.

CREATE TABLE IF NOT EXISTS public.serp_baseline_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug         text NOT NULL,

  /** Scope filter: 'all' (default) or 'tier1' or 'tier2' — limits which products run. */
  scope             text NOT NULL DEFAULT 'all' CHECK (scope IN ('all', 'tier1', 'tier2')),

  /** Lifecycle state. */
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),

  /** Total (kw × market) pairs to process. Computed at start. */
  total_pairs       int  NOT NULL DEFAULT 0,
  /** Pairs successfully processed (upserted to tier_serp_snapshots). */
  processed_pairs   int  NOT NULL DEFAULT 0,
  /** Pairs that failed (DataForSEO error / Supabase upsert error). */
  failed_pairs      int  NOT NULL DEFAULT 0,

  /** Pending pair list — array of {product_id, keyword, market} objects.
      Each tick pops up to CHUNK_SIZE off the front and processes them.
      Once empty, status flips to 'done'. */
  pending           jsonb NOT NULL DEFAULT '[]'::jsonb,

  /** Optional context for debugging. */
  notes             text,

  started_at        timestamptz NOT NULL DEFAULT now(),
  last_tick_at      timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS serp_baseline_runs_owner_idx
  ON public.serp_baseline_runs (owner_user_id, site_slug, started_at DESC);

CREATE INDEX IF NOT EXISTS serp_baseline_runs_active_idx
  ON public.serp_baseline_runs (status)
  WHERE status IN ('pending', 'running');

ALTER TABLE public.serp_baseline_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own SERP baseline runs"
  ON public.serp_baseline_runs FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

COMMENT ON TABLE public.serp_baseline_runs IS
  'Tracks chunked SERP baseline runs so long-running jobs survive Vercel 300s timeout.';
