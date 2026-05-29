-- Sprint MIMIR.POLISH.3 — Importance auto-tuning columns.
--
-- Tracks how often each memory has been "applied" (injected into a brief
-- prompt + the resulting brief was published) so the weekly cron can:
--   • decay  importance on memories never applied in 60 days  (-10, floor 30)
--   • boost  importance on memories applied without edits      (+5, cap 100)
--   • boost  importance on lessons that prevented past mistake (+10, cap 100)
--
-- Plus last_decayed_at to keep the weekly run idempotent — we only touch a
-- row if we haven't decayed/boosted it in the last 6 days.

ALTER TABLE mimir_memories
  ADD COLUMN IF NOT EXISTS applied_count    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_applied_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_tuned_at    timestamptz;

CREATE INDEX IF NOT EXISTS idx_mimir_memories_last_applied_at
  ON mimir_memories (owner_user_id, last_applied_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_mimir_memories_last_tuned_at
  ON mimir_memories (owner_user_id, last_tuned_at NULLS FIRST);

COMMENT ON COLUMN mimir_memories.applied_count
  IS 'Sprint MIMIR.POLISH.3 — count of briefs that injected this memory into prompt';
COMMENT ON COLUMN mimir_memories.last_applied_at
  IS 'Sprint MIMIR.POLISH.3 — most recent brief that used this memory';
COMMENT ON COLUMN mimir_memories.last_tuned_at
  IS 'Sprint MIMIR.POLISH.3 — last weekly auto-tune pass (prevents double-decay)';
