-- One-time bootstrap: seed `keyword_maps` + `keyword_map_clusters` from the
-- existing `tracked_products` table.
--
-- Idempotent: skips topics whose topic_slug already exists. Safe to re-run.
--
-- Two modes:
--   PARTIAL_TEST (default): only inserts the 3 hand-picked sample products
--     so you can sanity-check the structure before going wide.
--   Set PARTIAL_TEST = false to seed every active row in tracked_products.
--
-- Run from Supabase SQL editor. Replace v_owner uuid below if you want
-- to bootstrap for a specific user; otherwise it auto-detects the first
-- user that has tracked_products rows.

DO $$
DECLARE
  v_owner          uuid;
  v_partial_test   boolean := true;   -- ← flip to false for full bootstrap
  v_partial_names  text[]  := ARRAY[
    'Counter Strike Global Offensive Accounts',
    'Apex Legends Boosting Service',
    'Amazon Gift Cards'
  ];
  v_product        record;
  v_topic_slug     text;
  v_pillar_slug    text;
  v_pillar_title   text;
  v_map_id         uuid;
  v_keyword        text;
  v_idx            integer;
  v_inserted_maps  int := 0;
  v_inserted_clust int := 0;
  v_skipped_maps   int := 0;
BEGIN
  -- Auto-detect owner: first user that has any active tracked_products
  SELECT owner_user_id INTO v_owner
    FROM tracked_products
   WHERE active = true
   ORDER BY created_at ASC
   LIMIT 1;

  IF v_owner IS NULL THEN
    RAISE NOTICE 'No active tracked_products found — nothing to bootstrap.';
    RETURN;
  END IF;

  RAISE NOTICE 'Bootstrapping keyword_maps for owner_user_id %, partial_test = %',
               v_owner, v_partial_test;

  FOR v_product IN
    SELECT name, page_url, keywords, market
      FROM tracked_products
     WHERE owner_user_id = v_owner
       AND active = true
       AND ( NOT v_partial_test OR name = ANY(v_partial_names) )
     ORDER BY name
  LOOP
    -- Derive slugs
    v_topic_slug  := lower(regexp_replace(v_product.name, '[^a-zA-Z0-9]+', '-', 'g'));
    v_topic_slug  := regexp_replace(v_topic_slug, '(^-+|-+$)', '', 'g');

    -- pillar slug = path part of page_url, last segment
    v_pillar_slug := regexp_replace(v_product.page_url, '^.*/categories/', '');
    v_pillar_slug := regexp_replace(v_pillar_slug, '/.*$', '');

    -- pillar title — sane default if not customised
    v_pillar_title := 'Buy ' || v_product.name || ' — G2G Marketplace';

    -- Skip if topic already exists for this owner
    IF EXISTS (
      SELECT 1 FROM keyword_maps
       WHERE owner_user_id = v_owner AND topic_slug = v_topic_slug
    ) THEN
      v_skipped_maps := v_skipped_maps + 1;
      RAISE NOTICE '  skip: % (already exists)', v_product.name;
      CONTINUE;
    END IF;

    INSERT INTO keyword_maps (
      owner_user_id, topic, topic_slug, aliases,
      pillar_keyword, pillar_title, pillar_url_slug,
      market, status, ai_notes
    ) VALUES (
      v_owner, v_product.name, v_topic_slug,
      '{}'::text[],   -- aliases stay empty; Saga can propose adding them later
      COALESCE(v_product.keywords[1], v_topic_slug),
      v_pillar_title,
      v_pillar_slug,
      v_product.market,
      'in_progress',  -- pillar page already exists & live
      jsonb_build_object(
        'priority_note',  'Bootstrapped from tracked_products on ' || now()::date,
        'linking_note',   null,
        'estimated_weeks', null
      )
    )
    RETURNING id INTO v_map_id;
    v_inserted_maps := v_inserted_maps + 1;

    -- Insert one cluster per keyword in the array. First keyword = pillar.
    v_idx := 0;
    FOREACH v_keyword IN ARRAY v_product.keywords LOOP
      v_idx := v_idx + 1;
      INSERT INTO keyword_map_clusters (
        map_id, owner_user_id, keyword, intent, content_type,
        cluster_group, suggested_title, url_slug, priority_order,
        is_pillar, status, source, last_action_at
      ) VALUES (
        v_map_id, v_owner, v_keyword,
        'commercial',         -- safe default for marketplace category pages
        'landing_page',
        CASE WHEN v_idx = 1 THEN 'Pillar' ELSE 'Supporting' END,
        CASE WHEN v_idx = 1 THEN v_pillar_title ELSE NULL END,
        v_pillar_slug,
        v_idx,
        v_idx = 1,            -- first keyword is pillar
        'tracking',           -- pillar page already live; non-pillar = candidates to expand
        'manual',             -- bootstrap source
        now()
      );
      v_inserted_clust := v_inserted_clust + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'Bootstrap done: % maps inserted, % clusters inserted, % maps skipped (already existed).',
               v_inserted_maps, v_inserted_clust, v_skipped_maps;
END $$;
