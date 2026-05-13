-- ── Indonesian (ID) translation columns for product_content_queue ──────────
-- The product content sheet has columns H + I reserved for Indonesian
-- output. Previously the agent only filled F + G (English). Now sync also
-- generates the ID version, creates a separate Google Doc, and writes the
-- doc URL + status back to H + I.
--
-- Translation strategy: cheap Claude pass over the EN parsed JSON. Same
-- factual content, language flipped to ID. Stored alongside EN fields so
-- we keep both versions queryable.

alter table public.product_content_queue
  add column if not exists id_meta_title           text,
  add column if not exists id_meta_description     text,
  add column if not exists id_meta_keywords        text,
  add column if not exists id_marketing_title      text,
  add column if not exists id_marketing_description text,
  add column if not exists id_google_doc_url       text,
  /** id_status mirrors the sheet column I lifecycle:
   *  pending | generating | generated | uploading | uploaded | failed   */
  add column if not exists id_status               text default 'pending',
  add column if not exists id_generated_at         timestamptz,
  add column if not exists id_uploaded_at          timestamptz;

create index if not exists product_content_queue_id_status_idx
  on public.product_content_queue (owner_user_id, id_status);
