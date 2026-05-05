-- ── SERP Recommend tables ────────────────────────────────────────────────────
-- Two tables that power the manual "Get content ideas" flow on the SERP
-- Tracker History tab:
--
--   1. firecrawl_url_cache — caches per-URL scrape results for 7 days, since
--      competitor pages don't change minute-to-minute and Sonnet analysis
--      across multiple days/keywords often hits the same URLs. Cache cuts
--      FireCrawl spend 60-80% on repeat analyses.
--
--   2. serp_recommendations — persists each "Get content ideas" run so users
--      can revisit past Sonnet output without paying to regenerate, AND
--      track which ideas got pushed to Bragi (idea → brief lineage).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.firecrawl_url_cache (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  url           text        NOT NULL,
  -- Cached scrape payload — match the CrawledPage shape used by lib/firecrawl/client.ts
  -- so we can serialize/deserialize without translation.
  payload       jsonb       NOT NULL,
  scraped_at    timestamptz NOT NULL DEFAULT now(),
  -- TTL helper — read paths filter by `scraped_at > now() - interval '7 days'`
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  -- Track which workspace triggered the scrape (for usage attribution).
  -- The cache itself is shared across workspaces though — same competitor URL
  -- always produces the same content regardless of who scraped it.
  first_owner_user_id uuid  REFERENCES auth.users(id) ON DELETE SET NULL,

  UNIQUE (url)
);

CREATE INDEX IF NOT EXISTS firecrawl_url_cache_expires
  ON public.firecrawl_url_cache (expires_at);

CREATE INDEX IF NOT EXISTS firecrawl_url_cache_scraped
  ON public.firecrawl_url_cache (scraped_at DESC);


-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.serp_recommendations (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   uuid         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The snapshot date the recommendations were derived from.
  snapshot_date   date         NOT NULL,

  -- Diagnostic + audit
  generated_at    timestamptz  NOT NULL DEFAULT now(),
  model           text         NOT NULL,                  -- e.g. 'claude-sonnet-4-6'
  scrape_count    integer      NOT NULL DEFAULT 0,        -- how many FireCrawl calls (cache hits + misses)
  scrape_misses   integer      NOT NULL DEFAULT 0,        -- non-cached calls (actual cost)
  cost_usd        numeric(8,4),                            -- Sonnet + FireCrawl est USD

  -- The structured ideas array — see /api/competitive/serp-recommend response shape
  -- [{ id, type, title, body, target_keyword, target_url, suggested_brief_type, evidence }]
  ideas           jsonb        NOT NULL DEFAULT '[]'::jsonb,

  -- Tracks which ideas were pushed to the brief pipeline (lineage). Updated
  -- when the user clicks "🚀 Push to Bragi" on an individual idea.
  -- Shape: [{ idea_id, opp_id, pushed_at }]
  pushed_links    jsonb        NOT NULL DEFAULT '[]'::jsonb,

  UNIQUE (owner_user_id, snapshot_date, generated_at)
);

CREATE INDEX IF NOT EXISTS serp_recommendations_owner_date
  ON public.serp_recommendations (owner_user_id, snapshot_date DESC);

ALTER TABLE public.serp_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner can read their recommendations"
  ON public.serp_recommendations FOR SELECT TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  );

CREATE POLICY "owner can insert recommendations"
  ON public.serp_recommendations FOR INSERT TO authenticated
  WITH CHECK (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  );

CREATE POLICY "owner can update recommendations"
  ON public.serp_recommendations FOR UPDATE TO authenticated
  USING (
    owner_user_id = auth.uid() OR
    owner_user_id IN (
      SELECT owner_user_id FROM public.workspace_members WHERE member_user_id = auth.uid()
    )
  );
