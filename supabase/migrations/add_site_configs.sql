-- ── site_configs ─────────────────────────────────────────────────────────────
-- One row per tracked site/domain (G2G, OffGamers, etc.)
-- ga4_property_id is optional — populated when GA4 is connected for that site

CREATE TABLE IF NOT EXISTS public.site_configs (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  slug            text        UNIQUE NOT NULL,          -- 'g2g', 'offgamers'
  display_name    text        NOT NULL,                 -- 'G2G', 'OffGamers'
  favicon_domain  text        NOT NULL,                 -- 'g2g.com'
  gsc_property    text        NOT NULL,                 -- 'https://www.g2g.com/'
  semrush_domain  text        NOT NULL,                 -- 'g2g.com'
  ga4_property_id text,                                 -- '297450769' (optional)
  is_active       boolean     DEFAULT true,
  sort_order      int         DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

-- Everyone authenticated can read site configs (needed for switcher to work for team members)
ALTER TABLE public.site_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read site_configs"
  ON public.site_configs FOR SELECT
  TO authenticated
  USING (true);

-- ── Seed initial sites ─────────────────────────────────────────────────────────
-- GA4 property IDs are left NULL here — update after connecting GA4 per site
INSERT INTO public.site_configs (slug, display_name, favicon_domain, gsc_property, semrush_domain, ga4_property_id, sort_order)
VALUES
  ('g2g',        'G2G',        'g2g.com',        'https://www.g2g.com/',        'g2g.com',        NULL, 0),
  ('offgamers',  'OffGamers',  'offgamers.com',  'https://www.offgamers.com/',  'offgamers.com',  NULL, 1)
ON CONFLICT (slug) DO NOTHING;

-- ── Add site_slug to weekly_reports ───────────────────────────────────────────
-- Existing reports default to 'g2g'
ALTER TABLE public.weekly_reports
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

-- Index for fast filtering by site
CREATE INDEX IF NOT EXISTS weekly_reports_site_slug_idx
  ON public.weekly_reports (owner_user_id, site_slug, week_start DESC);
