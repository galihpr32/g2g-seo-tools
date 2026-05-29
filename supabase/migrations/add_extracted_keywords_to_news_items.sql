-- ── Keyword extraction on news_items ───────────────────────────────────────
-- Sprint NEWS_EXPORT.12: BDT (May 2026) flagged that the news export was
-- missing the most valuable column — the actual keyword/topic phrases that
-- come up in trending articles. We were extracting game names but throwing
-- away the substantive topics ("Path of Exile 2 endgame builds", "Genshin
-- 5.2 banner", etc.).
--
-- This column stores Haiku-extracted topic phrases per article. Filled
-- lazily on first export pass; cached forever so subsequent exports skip
-- the LLM call.

ALTER TABLE public.news_items
  /** Array of phrase objects: [{ phrase: string, relevance: 'high'|'medium'|'low' }, ...] */
  ADD COLUMN IF NOT EXISTS extracted_keywords  jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS keywords_extracted_at timestamptz;

-- Partial index for the "needs extraction" hot path. Most articles will
-- have keywords already after their first export; this index lets the
-- backfill find untouched rows fast.
CREATE INDEX IF NOT EXISTS news_items_no_keywords_idx
  ON public.news_items (owner_user_id, published_at DESC)
  WHERE keywords_extracted_at IS NULL;

COMMENT ON COLUMN public.news_items.extracted_keywords IS
  'Haiku-extracted topic phrases. Format: [{ phrase, relevance }, ...]. Populated lazily during news export runs.';
