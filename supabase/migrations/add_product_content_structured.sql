-- ── Structured Product Content (sheet-as-database refactor) ──────────────────
-- Workflow change (Galih's spec 2026-05-12):
--   • Sheet column E "Create now?" = "yes" (case-insensitive) → AI processes
--   • After: col E = "Generated" or "Error: <message>", not retriggerable
--   • Output written DIRECTLY back to sheet across 33 columns (A-AG):
--       L-S  = 8 H2 marketing sections (each cell = one section H2+body HTML)
--       T-AG = 7 FAQ Q/A pairs (Q and A in adjacent cells)
--   • Indonesian version mirrored to a separate "ID" sheet tab
--   • Google Drive doc creation REMOVED entirely
--
-- DB queue (`product_content_queue`) stays as a status mirror + audit log for
-- the dashboard/Details modal. The structured content lives in JSONB so the
-- modal can render the 8 sections + FAQ pairs without parsing HTML blobs.

ALTER TABLE public.product_content_queue
  ADD COLUMN IF NOT EXISTS request_date        date,
  ADD COLUMN IF NOT EXISTS marketing_sections  jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS faqs                jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS id_marketing_sections jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS id_faqs               jsonb NOT NULL DEFAULT '[]';

-- marketing_sections expected shape: ["<h2>...</h2><p>...</p>", ...] length 8
-- faqs expected shape:               [{ "q": "...", "a": "..." }, ...] length 5-7

COMMENT ON COLUMN public.product_content_queue.marketing_sections
  IS 'Array of 8 HTML strings, one per H2 section. Sheet cols L-S.';
COMMENT ON COLUMN public.product_content_queue.faqs
  IS 'Array of {q, a} objects, length 5-7. Sheet cols T-AG (Q+A in alternating cells).';

-- Legacy columns (marketing_description, meta_keywords, google_doc_url) kept
-- for backward compat but no longer populated by the new flow.
