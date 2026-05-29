-- ── Mimir Memory Persistence ───────────────────────────────────────────────
-- Long-lived facts, preferences, rules, and lessons that Mimir extracts from
-- conversations + manually-added memories. Retrieved at the start of every
-- chat and injected into the system prompt as "what I remember" context.
--
-- Why a dedicated table (not just append to mimir_conversations):
--   • Memories outlive the conversation that created them
--   • Cross-conversation reuse (knowledge gleaned in one chat informs another)
--   • Scoping (global vs site-specific vs product-specific) — same user can
--     have different memories per brand or per priority product
--   • Importance scoring + expiry let us cap context-budget usage and
--     auto-archive stale rules
--
-- Retrieval strategy (Sprint MIMIR.3):
--   Top-K by (matching_scope, category, tags overlap, importance, recency).
--   No embeddings — keyword + tag match is enough at our scale (single-team,
--   100-1000 memories max).

CREATE TABLE IF NOT EXISTS public.mimir_memories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  /** 'global' = applies in every chat for this owner.
   *  'site'   = only when the active site_slug matches this row's site_slug.
   *  'topic'  = scoped to a specific product / opportunity topic_slug.
   *  'product' = scoped to a specific relation_id (G2G catalog product). */
  scope               text NOT NULL DEFAULT 'global'
                      CHECK (scope IN ('global', 'site', 'topic', 'product')),
  site_slug           text,
  topic_slug          text,
  relation_id         uuid,

  /** Coarse buckets for filtering + UI grouping.
   *  preference = how the user likes things done (tone, format, ordering)
   *  fact       = verifiable info about the brand / team / product
   *  rule       = hard constraint Mimir must respect (do/don't)
   *  lesson     = mistake-from-history Mimir should not repeat */
  category            text NOT NULL DEFAULT 'fact'
                      CHECK (category IN ('preference', 'fact', 'rule', 'lesson')),

  /** Short canonical statement. Kept under ~280 chars so multiple memories
   *  fit in the system prompt without blowing the context budget. */
  content             text NOT NULL,

  /** Free-form tags for retrieval matching. e.g. ['bragi', 'on_page', 'genshin']. */
  tags                text[] NOT NULL DEFAULT '{}',

  /** 0-100. Higher = more important = preferred in top-K retrieval.
   *  Manual entries default to 70; extracted entries get scored 30-90 by
   *  the extractor based on signal strength. */
  importance          integer NOT NULL DEFAULT 50
                      CHECK (importance BETWEEN 0 AND 100),

  /** When true, ALWAYS include this memory in the chat context (subject to
   *  total budget cap). Used for inviolable rules and the user's pinned
   *  preferences. */
  pinned              boolean NOT NULL DEFAULT false,

  /** Soft expiry — once we pass this, retriever ignores the row.
   *  Useful for time-bounded facts ("Q4 promo runs until Dec 31"). NULL = never. */
  expires_at          timestamptz,

  /** Where this memory came from. Lets the admin UI link "Mimir said this
   *  in conversation X" so the user can re-verify. */
  source_kind         text NOT NULL DEFAULT 'manual'
                      CHECK (source_kind IN ('manual', 'extracted', 'imported')),
  source_conversation_id uuid,

  /** Soft-delete instead of hard delete — keeps audit trail for "why did
   *  Mimir stop remembering X?" investigations. */
  archived            boolean NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Retrieval indexes ─────────────────────────────────────────────────────────
-- Hot path: load all active memories for this owner + scope filter, then
-- rank in memory. GIN on tags so we can do contains-any lookups for tag
-- match without a sequential scan.

CREATE INDEX IF NOT EXISTS mimir_memories_owner_scope_idx
  ON public.mimir_memories (owner_user_id, scope, archived);

CREATE INDEX IF NOT EXISTS mimir_memories_site_idx
  ON public.mimir_memories (owner_user_id, site_slug) WHERE site_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS mimir_memories_topic_idx
  ON public.mimir_memories (owner_user_id, topic_slug) WHERE topic_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS mimir_memories_relation_idx
  ON public.mimir_memories (owner_user_id, relation_id) WHERE relation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mimir_memories_tags_idx
  ON public.mimir_memories USING gin (tags);

CREATE INDEX IF NOT EXISTS mimir_memories_pinned_idx
  ON public.mimir_memories (owner_user_id, pinned) WHERE pinned = true;

ALTER TABLE public.mimir_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own mimir memories"
  ON public.mimir_memories FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

COMMENT ON TABLE public.mimir_memories IS
  'Persistent memories injected into Mimir chat context. Extracted post-conversation by Haiku and/or added manually via /mimir/memories admin.';
