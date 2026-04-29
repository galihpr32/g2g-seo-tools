-- ─────────────────────────────────────────────────────────────────
-- Fix seo_content_briefs_brief_type_check constraint
--
-- Original constraint only allowed a subset (likely 'on_page' / 'off_page'),
-- which caused Pipeline Journey approve flow to fail silently for
-- 'category_page', 'outreach', and 'blog_post' brief types.
--
-- Symptom (before fix): "Approved — 0 briefs queued" for any output type
--   except 'optimize_existing'. INSERT was hitting CHECK violation 23514.
--
-- Allowed values (post-fix):
--   - on_page         → optimize_existing approves (Heimdall, Loki defaults)
--   - off_page        → legacy, kept for compat (BriefViewer.tsx still references)
--   - category_page   → new_page approves (Odin uses this)
--   - outreach        → outreach approves (Hermod feed)
--   - blog_post       → guest-article approves (external editorial publications)
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE seo_content_briefs
  DROP CONSTRAINT IF EXISTS seo_content_briefs_brief_type_check;

ALTER TABLE seo_content_briefs
  ADD CONSTRAINT seo_content_briefs_brief_type_check
  CHECK (brief_type IN (
    'on_page',
    'off_page',
    'category_page',
    'outreach',
    'blog_post'
  ));

-- Verify (run after the ALTER):
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conname = 'seo_content_briefs_brief_type_check';
