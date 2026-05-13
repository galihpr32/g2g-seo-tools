-- Capture WHY a product content row failed to generate, so users can see
-- the actual cause (Drive API not enabled, folder permission denied, JSON
-- parse error, etc.) instead of just an opaque "failed" badge.
--
-- Two columns: one for the EN generation step (Haiku → Drive doc), another
-- for the ID translation step. Both surface in the Details modal.

alter table public.product_content_queue
  add column if not exists generation_error    text,
  add column if not exists id_generation_error text;
