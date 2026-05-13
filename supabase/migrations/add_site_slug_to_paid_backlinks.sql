-- ── Paid backlinks per-site (Phase 3 final closeout) ─────────────────────────
-- paid_backlinks didn't have site_slug, so monthly/weekly reports for OG were
-- pulling G2G's backlinks too. Add the column and backfill from target_page —
-- URLs containing 'offgamers' get tagged 'offgamers', everything else stays
-- 'g2g' (G2G has been the only brand until now).

ALTER TABLE public.paid_backlinks
  ADD COLUMN IF NOT EXISTS site_slug text NOT NULL DEFAULT 'g2g';

-- Backfill: any existing row whose target_page mentions offgamers → 'offgamers'
UPDATE public.paid_backlinks
SET site_slug = 'offgamers'
WHERE target_page ILIKE '%offgamers.com%'
  AND site_slug = 'g2g';

CREATE INDEX IF NOT EXISTS paid_backlinks_site_slug_idx
  ON public.paid_backlinks (owner_user_id, site_slug, link_status);
