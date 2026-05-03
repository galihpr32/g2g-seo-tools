-- ─────────────────────────────────────────────────────────────────────────────
-- Outreach (Hermod) stuck — diagnostic queries
-- Run each block separately (highlight + Run selection in Supabase) and paste
-- the output back. We'll figure out scenario 1/2/3 from this.
-- ─────────────────────────────────────────────────────────────────────────────

-- (1) Hermod agent_runs — last 10 runs, sorted newest first
-- Looking for: is Hermod actually being invoked? When was last run?
-- What does the summary say (e.g. "no candidates", "queued action", real prospects found)?
SELECT
  id,
  agent_key,
  status,
  started_at,
  finished_at,
  EXTRACT(EPOCH FROM (NOW() - started_at))/3600 AS hours_ago,
  summary,
  site_slug
FROM agent_runs
WHERE agent_key = 'hermod'
ORDER BY started_at DESC
LIMIT 10;

-- ─────────────────────────────────────────────────────────────────────────────

-- (2) outreach_prospects existing — what's in the table at all?
-- If this is empty: Hermod has NEVER produced a prospect.
-- If has rows: check source_keyword vs opp.topic match.
SELECT
  p.id,
  p.domain,
  p.source_keyword,
  p.status,
  p.claimed_by,
  p.created_at,
  p.updated_at
FROM outreach_prospects p
ORDER BY p.created_at DESC
LIMIT 20;

-- ─────────────────────────────────────────────────────────────────────────────

-- (3) Source-keyword vs opp.topic matching for published opps
-- This is the matching logic in pipeline-journey route. If a prospect's
-- source_keyword doesn't EXACTLY equal opp.topic, the UI won't link them.
-- We want to see: published opps + any prospect with similar source_keyword.
SELECT
  o.topic                                AS opp_topic,
  o.status                               AS opp_status,
  COUNT(p.id)                            AS exact_match_prospects,
  COALESCE(STRING_AGG(DISTINCT p.source_keyword, ' | '), '(none)') AS prospect_keywords,
  EXTRACT(EPOCH FROM (NOW() - MAX(b.published_at)))/3600 AS hours_since_published
FROM seo_opportunities o
LEFT JOIN seo_content_briefs b ON b.id = o.brief_id
LEFT JOIN outreach_prospects p ON LOWER(p.source_keyword) LIKE '%' || LOWER(SPLIT_PART(o.topic, ' ', 1)) || '%'
WHERE o.status IN ('brief_ready', 'published')
  AND b.status = 'published'
GROUP BY o.id, o.topic, o.status
ORDER BY MAX(b.published_at) DESC
LIMIT 20;

-- Read this output as: for each published opp, how many prospects have a
-- source_keyword that even loosely matches the topic. If 0, Hermod never
-- searched for this topic. If >0 but exact_match in pipeline-journey is 0,
-- it's a normalization bug.

-- ─────────────────────────────────────────────────────────────────────────────

-- (4) Pending Hermod-queued actions — does Hermod ask for SERP snapshot first?
-- Per HANDOFF section 4: Hermod should queue add_action_item asking user to
-- click /competitive/serp-tracker?keywords=X,Y,Z. If those actions are
-- pending unread, Hermod is blocked waiting for user input.
SELECT
  a.id,
  a.action_type,
  a.status,
  a.agent_key,
  a.created_at,
  a.data
FROM agent_actions a
WHERE a.agent_key = 'hermod'
  AND a.status = 'pending'
ORDER BY a.created_at DESC
LIMIT 10;

-- ─────────────────────────────────────────────────────────────────────────────

-- (5) Agent run summary — top 3 reasons Hermod ended in last 10 runs
SELECT
  status,
  CASE
    WHEN summary ILIKE '%no candidates%'   THEN 'no candidates'
    WHEN summary ILIKE '%no prospects%'    THEN 'no prospects'
    WHEN summary ILIKE '%serp_snapshot%'   THEN 'needs serp snapshot'
    WHEN summary ILIKE '%no loki%'         THEN 'no loki gaps'
    WHEN summary ILIKE '%error%'           THEN 'error'
    WHEN summary ILIKE '%found%' AND summary NOT ILIKE '%no%' THEN 'found prospects'
    ELSE 'other'
  END                       AS classified,
  COUNT(*)                  AS count,
  STRING_AGG(DISTINCT LEFT(summary, 120), ' | ') AS sample_summaries
FROM agent_runs
WHERE agent_key = 'hermod'
  AND started_at > NOW() - INTERVAL '14 days'
GROUP BY 1, 2
ORDER BY count DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- What the output tells us:
--
-- Scenario 1 (Hermod gak jalan / blocked):
--   - Query 1: latest started_at > 6 hours ago, OR no rows at all
--   - Query 4: pending Hermod actions exist (user belum klik)
--   → Fix: trigger Hermod manually, OR click pending action items
--
-- Scenario 2 (matching bug — source_keyword != opp.topic):
--   - Query 2: ada rows
--   - Query 3: prospect_keywords ada nilai-nya tapi exact_match_prospects = 0
--   → Fix: normalize matching di pipeline-journey route (lowercase, strip suffix)
--
-- Scenario 3 (Hermod jalan, gak nemu prospect — topic gak fit):
--   - Query 1: regular runs every ~30 min
--   - Query 5: dominant classified = "no candidates" / "no prospects"
--   - Query 2/3: zero rows for those topics
--   → Fix: UX message ("no prospects found"), manual entry escape hatch
-- ─────────────────────────────────────────────────────────────────────────────
