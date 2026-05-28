-- Sprint DMCA.TAGGING — flag products with legal/platform restrictions
-- so we can explain WHY they don't rank well. Examples:
--   • DMCA       — Genshin, Honkai Star Rail (HoYoverse takedowns)
--   • Trademark  — protected brand restrictions
--   • RegionLock — region-licensed content (e.g. China-only)
--   • TOS        — platform Terms-of-Service restrictions (e.g. Mobile Legends bans selling)
-- NULL = no known restriction (default for all existing rows).

ALTER TABLE public.product_tiers
  ADD COLUMN IF NOT EXISTS restriction_type text
    CHECK (restriction_type IN ('DMCA', 'Trademark', 'RegionLock', 'TOS'));

CREATE INDEX IF NOT EXISTS product_tiers_restriction_idx
  ON public.product_tiers (restriction_type)
  WHERE restriction_type IS NOT NULL;

COMMENT ON COLUMN public.product_tiers.restriction_type IS
  'Legal/platform restriction context. NULL = unrestricted. Filter "is restricted" = restriction_type IS NOT NULL.';
