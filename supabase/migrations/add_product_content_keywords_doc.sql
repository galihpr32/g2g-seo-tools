-- ── Add keyword and Google Doc columns to product_content_queue ───────────────
-- These columns store:
--   main_keyword       — primary keyword discovered/used during content generation
--   secondary_keywords — comma-separated secondary keywords (from DataForSEO)
--   google_doc_url     — Google Doc URL (backup output alongside DB storage)

ALTER TABLE public.product_content_queue
  ADD COLUMN IF NOT EXISTS main_keyword       text,
  ADD COLUMN IF NOT EXISTS secondary_keywords text,
  ADD COLUMN IF NOT EXISTS google_doc_url     text;

-- Optional index on google_doc_url for quick lookups (mostly for display)
CREATE INDEX IF NOT EXISTS product_content_queue_doc_url
  ON public.product_content_queue (owner_user_id, google_doc_url)
  WHERE google_doc_url IS NOT NULL;
