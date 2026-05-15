-- Sprint FRIDAY.KPI.INFRA — Groundwork for the weekly Friday KPI digest.
-- We're not building the digest logic yet; this migration just adds the
-- columns it will read so the eventual cron can be a pure SELECT-and-format.
--
-- Three additions on seo_action_items:
--   • notification_type — taxonomic bucket for the Friday roll-up
--                          ('tier_rank', 'gsc_signal', 'cms_alert', 'cost_alert',
--                           'backlink', 'mimir', 'manual', …). Currently inferred
--                          ad-hoc from action_type; promoting to a first-class
--                          column lets us GROUP BY cleanly in the digest.
--   • search_volume     — DataForSEO SV at time of insert. Friday digest sorts
--                          by SV so high-impact items rise to the top regardless
--                          of which agent reported them.
--   • intent            — 'transactional' | 'commercial' | 'informational' |
--                          'navigational'. Lets the digest filter to commercial
--                          intent only when bos asks "show me revenue items".
--
-- Backfill strategy (post-deploy, manual SQL — not in this migration):
--   • notification_type: best-effort map from existing action_type strings
--   • search_volume:     leave NULL; the next refresh cron will fill in
--   • intent:            leave NULL; Haiku classifier will batch-fill async
--
-- All three are nullable so existing inserts don't break.

ALTER TABLE public.seo_action_items
  ADD COLUMN IF NOT EXISTS notification_type text,
  ADD COLUMN IF NOT EXISTS search_volume     integer,
  ADD COLUMN IF NOT EXISTS intent            text;

-- Friday digest GROUP BY notification_type — full index on the column.
CREATE INDEX IF NOT EXISTS seo_action_items_notification_type_idx
  ON public.seo_action_items (notification_type);

-- Friday digest sorts DESC by search_volume; partial index for non-null only
-- so we don't waste pages on the (huge) NULL bucket until backfill runs.
CREATE INDEX IF NOT EXISTS seo_action_items_search_volume_idx
  ON public.seo_action_items (search_volume DESC)
  WHERE search_volume IS NOT NULL;

-- Intent filter — small set, partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS seo_action_items_intent_idx
  ON public.seo_action_items (intent)
  WHERE intent IS NOT NULL;

-- Soft constraint: intent values stay in the four-bucket taxonomy. We DON'T
-- add a hard CHECK because legacy rows may have free-form values; the
-- Haiku classifier writes only normalized values going forward.
COMMENT ON COLUMN public.seo_action_items.intent IS
  'Expected values: transactional | commercial | informational | navigational. Soft-typed for legacy compatibility.';
COMMENT ON COLUMN public.seo_action_items.notification_type IS
  'Friday KPI digest grouping key. Expected: tier_rank | gsc_signal | cms_alert | cost_alert | backlink | mimir | manual';
COMMENT ON COLUMN public.seo_action_items.search_volume IS
  'DataForSEO monthly search volume captured at item creation. Used by the Friday digest to sort by potential impact.';
