-- ── G2G CMS Direct API integration ───────────────────────────────────────────
-- Replaces the friend's local Firefox + cookies upload script with a
-- server-side HTTP-only integration. After AI content generation, our cron
-- automatically PUTs to G2G's admin REST API:
--   PUT /offer/keyword_relation/{relation_id}   — marketing + SEO (1 endpoint)
--   PUT /offer/product_settings                  — FAQ (per-language: 2 calls)
--
-- Auth: X-Api-Key (static, set in env) + Authorization: Bearer JWT.
-- JWT expires ~1 week. User manually pastes refreshed JWT via the new
-- /settings/cms-token page; we store encrypted-at-rest in cms_tokens table.

-- ── cms_tokens — one JWT per (owner × site_slug) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.cms_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  /** 'g2g' | 'offgamers' — each brand may have its own admin session. */
  site_slug       text NOT NULL,
  /** Full bearer token string (the value after "Bearer "). Stored as text
   *  inside an RLS-protected table — Supabase service-role auth + RLS gates
   *  is the practical security boundary for our app. If we ever push to a
   *  multi-tenant SaaS shape we can swap in Supabase Vault encryption. */
  token           text NOT NULL,
  /** Parsed from JWT exp claim. Used by the upload pipeline to short-circuit
   *  if token is already known-expired before making the API call. */
  expires_at      timestamptz,
  /** Optional: parsed sub claim or email from token for display. */
  token_subject   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, site_slug)
);

ALTER TABLE public.cms_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own CMS tokens"
  ON public.cms_tokens FOR ALL
  USING  (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE INDEX IF NOT EXISTS cms_tokens_owner_site_idx
  ON public.cms_tokens (owner_user_id, site_slug);

-- ── product_content_queue — upload tracking columns ─────────────────────────
ALTER TABLE public.product_content_queue
  /** Cached after first successful GET /offer/keyword_relation. Skips an
   *  extra GET on subsequent runs. */
  ADD COLUMN IF NOT EXISTS g2g_brand_id        text,
  ADD COLUMN IF NOT EXISTS g2g_service_id      text,
  /** 'pending' | 'uploading' | 'uploaded' | 'failed' | 'awaiting_token'.
   *  Separate from `status` because upload happens AFTER content generation —
   *  a row can be status='generated' (AI done) and cms_upload_status='pending'
   *  (not yet pushed to CMS). */
  ADD COLUMN IF NOT EXISTS cms_upload_status   text,
  ADD COLUMN IF NOT EXISTS cms_uploaded_at     timestamptz,
  /** Stage-tagged error like "[stage:put_marketing] 500 — ...". Surfaces in
   *  the Details modal for debugging without crawling Vercel logs. */
  ADD COLUMN IF NOT EXISTS cms_upload_error    text;

CREATE INDEX IF NOT EXISTS product_content_queue_cms_upload_idx
  ON public.product_content_queue (owner_user_id, cms_upload_status);

-- ── cms_alert_history — throttle "JWT expired" Slack notifications ──────────
-- Without throttling, every failed upload would Slack-spam Galih.
CREATE TABLE IF NOT EXISTS public.cms_alert_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL,
  alert_type      text NOT NULL,   -- 'jwt_expired' | 'api_error' | ...
  alerted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cms_alert_recent_idx
  ON public.cms_alert_history (owner_user_id, site_slug, alert_type, alerted_at DESC);

COMMENT ON TABLE public.cms_tokens IS
  'G2G admin JWT bearer tokens (manually refreshed weekly via /settings/cms-token).';
COMMENT ON TABLE public.cms_alert_history IS
  'Throttle log for Slack notifications about CMS upload failures (max 1 per 6h per alert_type).';
