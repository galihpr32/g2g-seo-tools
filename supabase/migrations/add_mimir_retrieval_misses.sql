-- ── Mimir retrieval miss tracking ────────────────────────────────────────
-- Sprint MIMIR.LEARN — logs every time the retriever returned ZERO
-- memories because the best similarity score was below the threshold.
-- This data drives /reports/mimir-learning's "Knowledge gaps" section so
-- Galih can see what topics/categories Mimir doesn't know yet, and seed
-- memories proactively.

CREATE TABLE IF NOT EXISTS public.mimir_retrieval_misses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug            text,

  /** Raw query text the user/agent sent. Truncated to 500 chars to avoid bloat. */
  query                text NOT NULL,
  /** Highest similarity score among all candidates (still below threshold). */
  top_score            float NOT NULL DEFAULT 0,
  /** Threshold value at time of query — varies per retriever config. */
  threshold            float NOT NULL DEFAULT 0.5,
  /** Up to 3 closest memory IDs (rejected) for debugging which memories were close. */
  closest_memory_ids   uuid[],

  /** Auto-classified topic + category for aggregation (Haiku populates async). */
  topic                text,           -- "wuwa top-up", "valorant skins"
  category             text,           -- "Gaming Currency", "Game Cards"
  classified_at        timestamptz,    -- when the Haiku classifier ran

  /** Optional context — links back to the chat or agent run that triggered it. */
  source               text,           -- 'mimir_chat' | 'agent_<name>' | 'manual'
  source_ref           text,           -- chat_session_id or run_id

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mimir_misses_owner_recent_idx
  ON public.mimir_retrieval_misses (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS mimir_misses_category_idx
  ON public.mimir_retrieval_misses (owner_user_id, category)
  WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS mimir_misses_topic_idx
  ON public.mimir_retrieval_misses (owner_user_id, topic)
  WHERE topic IS NOT NULL;

CREATE INDEX IF NOT EXISTS mimir_misses_unclassified_idx
  ON public.mimir_retrieval_misses (created_at)
  WHERE classified_at IS NULL;

ALTER TABLE public.mimir_retrieval_misses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see own retrieval misses"
  ON public.mimir_retrieval_misses FOR SELECT
  USING (auth.uid() = owner_user_id);

-- Inserts come from server-side service-role code; no policy needed on INSERT.

COMMENT ON TABLE public.mimir_retrieval_misses IS
  'Logs when Mimir retriever found zero memories above threshold. Drives knowledge gap dashboard.';
