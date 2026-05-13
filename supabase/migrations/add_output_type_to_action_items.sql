-- ── output_type on seo_action_items ────────────────────────────────────────
-- Bragi (brief generator) previously branched only on `action_type`
-- ('on_page' vs 'off_page'), which made every "create new page", "optimize
-- existing", and "blog post" request produce identical refresh-style briefs.
--
-- Adding `output_type` so the brief pipeline can pick the right prompt:
--   - new_page          → create from scratch (no crawl needed)
--   - optimize_existing → refresh existing page (current on-page logic)
--   - blog_post         → editorial article structure
--   - outreach          → off-page outreach (already worked)
--
-- Migration is non-destructive: existing rows get a sensible default derived
-- from their action_type so the pipeline keeps working until the next
-- backfill (run from /api/admin/backfill-output-type).

ALTER TABLE public.seo_action_items
  ADD COLUMN IF NOT EXISTS output_type text;

-- Backfill: anything currently action_type='on_page' is treated as a refresh
-- (the previous default); off_page → outreach. Brand-new rows from competitive
-- keyword-gap (which sets action_type='new_page' — a misnamed action_type
-- value) get output_type='new_page' going forward via the API layer.
UPDATE public.seo_action_items
   SET output_type = CASE
     WHEN action_type = 'on_page'  THEN 'optimize_existing'
     WHEN action_type = 'off_page' THEN 'outreach'
     WHEN action_type = 'new_page' THEN 'new_page'
     ELSE 'optimize_existing'
   END
 WHERE output_type IS NULL;

CREATE INDEX IF NOT EXISTS seo_action_items_output_type_idx
  ON public.seo_action_items (output_type);

COMMENT ON COLUMN public.seo_action_items.output_type IS
  'Drives Bragi prompt selection. Values: new_page | optimize_existing | blog_post | outreach.';

-- ── Mirror onto seo_content_briefs ──────────────────────────────────────────
-- We persist output_type on the brief row too so historical briefs stay
-- attributable to their original pipeline branch even if the action_item is
-- later edited or deleted.

ALTER TABLE public.seo_content_briefs
  ADD COLUMN IF NOT EXISTS output_type text;

CREATE INDEX IF NOT EXISTS seo_content_briefs_output_type_idx
  ON public.seo_content_briefs (output_type);

COMMENT ON COLUMN public.seo_content_briefs.output_type IS
  'Snapshot of action_item.output_type at brief generation time.';
