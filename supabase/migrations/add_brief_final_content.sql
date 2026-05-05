-- ── Brief Final Content ───────────────────────────────────────────────────────
-- Stores the FULL article body (Bragi assembly step output), as opposed to
-- the existing content_draft which is just a summary header (H1 + meta + intent).
--
-- Flow:
--   1. Bragi generates outline + FAQ + keywords  → seo_content_briefs (draft)
--   2. Tyr reviews                                → tyr_score, tyr_status
--   3. If Tyr passes (or override → reviewed)    → assembly Bragi call writes final_content
--   4. Writer edits in-place                     → final_content_edited_at = now()
--   5. Translate button                          → final_content_translations[lang]
--   6. Mark Published                            → status='published', published_at, etc.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS final_content              text,           -- full markdown article body
  ADD COLUMN IF NOT EXISTS final_content_generated_at timestamptz,    -- Bragi assembly timestamp
  ADD COLUMN IF NOT EXISTS final_content_edited_at    timestamptz,    -- writer's last manual edit
  ADD COLUMN IF NOT EXISTS final_content_translations jsonb           -- { "id": "<translated markdown>", "es": "...", ... }
                                                       DEFAULT '{}'::jsonb;

-- Index lookup for pending assembly (briefs that passed Tyr but haven't been
-- assembled yet) — used by a future cron sweep if user wants async assembly.
CREATE INDEX IF NOT EXISTS seo_content_briefs_pending_assembly
  ON public.seo_content_briefs (owner_user_id, status)
  WHERE status IN ('reviewed', 'agent_generated') AND final_content IS NULL;
