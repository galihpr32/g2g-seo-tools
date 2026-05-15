-- Sprint MIMIR.MARKET — per-market memory scope
-- Lets Mimir store separate decisions/patterns for the same product across
-- markets (EN-Global vs ID-Indonesia). E.g. "Genshin Top-Up CTA tone for ID"
-- is different from "Genshin Top-Up CTA tone for Global".

ALTER TABLE public.mimir_memories
  ADD COLUMN IF NOT EXISTS market text;
-- NULL market = memory applies to ALL markets (default behaviour).
-- Set to 'us', 'id', etc to scope memory to one market.

CREATE INDEX IF NOT EXISTS mimir_memories_market_idx
  ON public.mimir_memories (owner_user_id, scope, market)
  WHERE archived = false;

COMMENT ON COLUMN public.mimir_memories.market IS
  'Optional market scope. NULL = applies to all markets. Set to a market code (us, id, de, fr, my) to limit retrieval.';
