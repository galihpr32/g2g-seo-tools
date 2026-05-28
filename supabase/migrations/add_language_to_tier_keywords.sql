-- Sprint MARKETS.PRUNE — keyword language scope
-- Lets us mark Indonesian-language keywords ('cara top up X', 'harga X termurah')
-- so they only run against the ID market — saves DataForSEO budget vs running
-- ID-language kws against US/EN markets where they'd never rank.

ALTER TABLE public.tier_keywords
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en'
    CHECK (language IN ('en', 'id'));

CREATE INDEX IF NOT EXISTS tier_keywords_language_idx
  ON public.tier_keywords (language);

COMMENT ON COLUMN public.tier_keywords.language IS
  'Keyword language. EN = run against US (global proxy). ID = run against ID market only. Default en.';
