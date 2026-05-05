-- ── WIPE PIPELINE DATA — FRESH START ──────────────────────────────────────────
-- Run this ONCE in Supabase SQL Editor after deploying the Tema 2 brief
-- consolidation + outreach mode changes. It clears all opportunity / brief /
-- prospect / agent_action rows so the pipeline starts clean and avoids
-- showing legacy Bragi-generated content (which used the old prompts).
--
-- ⚠ IRREVERSIBLE. Take a Supabase backup first if you want a rollback path.
--
-- WHAT IT DELETES (per workspace owner):
--   - brief_outcomes        (ranking-impact tracker rows; depends on briefs)
--   - seo_content_briefs    (all briefs incl. legacy SEO + outreach)
--   - outreach_prospects    (per-prospect emails — new pitches will replace)
--   - seo_opportunities     (Saga-aggregated opportunities)
--   - agent_actions         (queued draft_brief / draft_outreach actions)
--
-- WHAT IT KEEPS (intentionally):
--   - keyword_map_clusters / keyword_maps (your topical map structure)
--   - knowledge_base_items (brand context, categories, prompts, platforms)
--   - category_prompts     (prompt template overrides)
--   - api_usage_logs       (cost history is auditable)
--   - agent_runs           (run history for /command-center/health)
--   - workspace_members    (team setup)
--
-- USAGE
--   1. Copy this file's body into Supabase SQL Editor
--   2. Replace the OWNER UUID below with your workspace owner's user ID
--   3. Run. Should report row counts deleted.
-- ──────────────────────────────────────────────────────────────────────────────

-- ▼ Replace with the workspace owner UUID (visible in /command-center/health
--   header, or run: SELECT id FROM auth.users WHERE email = 'galih.priambodo@g2g.com';)
\set owner '00000000-0000-0000-0000-000000000000'

BEGIN;

-- 1. Brief outcomes (FK → seo_content_briefs)
DELETE FROM public.brief_outcomes
 WHERE owner_user_id = :'owner';

-- 2. Outreach prospects
DELETE FROM public.outreach_prospects
 WHERE owner_user_id = :'owner';

-- 3. Seo content briefs (after outcomes cleared)
DELETE FROM public.seo_content_briefs
 WHERE owner_user_id = :'owner';

-- 4. Seo opportunities (Saga-aggregated)
DELETE FROM public.seo_opportunities
 WHERE owner_user_id = :'owner';

-- 5. Agent actions (queued draft_brief / draft_outreach / etc.)
DELETE FROM public.agent_actions
 WHERE owner_user_id = :'owner';

-- 6. (Optional) AI visibility snapshots — uncomment if you want to wipe Frey too
-- DELETE FROM public.ai_visibility_snapshots
--  WHERE owner_user_id = :'owner';
-- DELETE FROM public.ai_visibility_responses
--  WHERE owner_user_id = :'owner';

COMMIT;

-- Verification: should all return 0
SELECT 'brief_outcomes'      AS table_name, COUNT(*) AS remaining FROM public.brief_outcomes      WHERE owner_user_id = :'owner'
UNION ALL
SELECT 'outreach_prospects',  COUNT(*)                            FROM public.outreach_prospects  WHERE owner_user_id = :'owner'
UNION ALL
SELECT 'seo_content_briefs',  COUNT(*)                            FROM public.seo_content_briefs  WHERE owner_user_id = :'owner'
UNION ALL
SELECT 'seo_opportunities',   COUNT(*)                            FROM public.seo_opportunities   WHERE owner_user_id = :'owner'
UNION ALL
SELECT 'agent_actions',       COUNT(*)                            FROM public.agent_actions       WHERE owner_user_id = :'owner';
