-- Sprint MIMIR.ONPAGE — Track on-page-learner jobs so the UI can show
-- per-dimension progress without keeping the HTTP request alive.
--
-- Flow:
--   1. UI POSTs /api/mimir/onpage/learn — creates a job row (pending)
--   2. Endpoint kicks off processing via after() and returns job_id
--   3. UI polls GET /api/mimir/onpage/learn/[id] every 2s
--   4. After each dimension, the worker UPDATEs progress columns
--   5. Done → status='completed', summary populated
--
-- Why a table instead of in-memory: Vercel serverless functions don't share
-- memory across invocations. Persisting state lets the same UI session see
-- updates even if a different lambda instance handles the poll.

CREATE TABLE IF NOT EXISTS public.mimir_onpage_jobs (
  id                 uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id      uuid    NOT NULL,
  site_slug          text    NOT NULL,
  status             text    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'completed', 'failed')),

  -- Inputs (snapshotted at submission so UI can display them)
  page_count         integer NOT NULL,
  dimensions         text[]  NOT NULL,
  replace_strategy   boolean NOT NULL DEFAULT false,

  -- Live progress
  total_steps        integer NOT NULL,                  -- # dimensions to process
  completed_steps    integer NOT NULL DEFAULT 0,
  current_dimension  text,                              -- nullable while pending/done

  -- Results
  total_inserted     integer NOT NULL DEFAULT 0,
  total_deleted      integer NOT NULL DEFAULT 0,
  per_dimension      jsonb,                             -- full DimensionResult[] when done
  error_message      text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  completed_at       timestamptz
);

CREATE INDEX IF NOT EXISTS mimir_onpage_jobs_owner_idx
  ON public.mimir_onpage_jobs (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mimir_onpage_jobs_status_idx
  ON public.mimir_onpage_jobs (status)
  WHERE status IN ('pending', 'running');

COMMENT ON TABLE public.mimir_onpage_jobs IS
  'Sprint MIMIR.ONPAGE — Tracks asynchronous on-page pattern extraction jobs so the UI can show progress per dimension.';
