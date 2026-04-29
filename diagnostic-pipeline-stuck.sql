-- ────────────────────────────────────────────────────────────────────────────
-- Pipeline Journey — diagnostic queries (2026-04-29)
-- Run these in Supabase SQL editor and paste back the rows.
-- This tells us WHY the 6 opps are stuck before we patch anything.
-- ────────────────────────────────────────────────────────────────────────────

-- A) The 6 (or however many) stuck opps + their linked primary brief.
--    Reveals: is brief_id null? does the brief exist? what's its real status?
--    is the notes tag intact? did Bragi actually finish (content_outline non-null)?
SELECT
  o.id            AS opp_id,
  o.topic,
  o.status        AS opp_status,
  o.brief_id      AS opp_brief_id,
  o.output_type,
  o.updated_at    AS opp_updated,

  b.id            AS linked_brief_id,
  b.status        AS brief_status,
  b.tyr_status,
  b.tyr_score,
  b.brief_type,
  b.primary_keyword,
  b.updated_at    AS brief_updated,
  b.notes IS NOT NULL                              AS has_notes,
  b.notes LIKE '%Queued from Opportunity%'         AS has_opp_tag,
  b.content_outline IS NOT NULL                    AS bragi_finished_outline,
  b.content_draft  IS NOT NULL                     AS bragi_finished_draft
FROM seo_opportunities o
LEFT JOIN seo_content_briefs b ON b.id = o.brief_id
WHERE o.status = 'brief_queued'
  AND o.owner_user_id = auth.uid()   -- comment this out if running as service_role
ORDER BY o.updated_at DESC;

-- ────────────────────────────────────────────────────────────────────────────

-- B) ALL briefs tagged "Queued from Opportunity" in last 14 days, regardless
--    of whether opp.brief_id points to them. Catches multi-type approvals
--    (e.g. New Page + Optimise Existing → 2 briefs per opp).
SELECT
  b.id,
  b.status,
  b.tyr_status,
  b.brief_type,
  b.primary_keyword,
  b.created_at,
  b.updated_at,
  EXTRACT(EPOCH FROM (NOW() - b.updated_at))/60   AS minutes_since_update,
  SUBSTRING(b.notes FROM 'Queued from Opportunity:.*\(([0-9a-f-]{36})\)') AS tagged_opp_id,
  b.notes IS NOT NULL                              AS has_notes,
  b.content_outline IS NOT NULL                    AS bragi_finished
FROM seo_content_briefs b
WHERE b.notes LIKE '%Queued from Opportunity%'
  AND b.created_at > NOW() - INTERVAL '14 days'
ORDER BY b.created_at DESC;

-- ────────────────────────────────────────────────────────────────────────────

-- C) Quick aggregate — how many briefs are stuck where, right now?
SELECT
  status,
  COUNT(*) AS count,
  MIN(updated_at) AS oldest,
  MAX(updated_at) AS newest
FROM seo_content_briefs
WHERE notes LIKE '%Queued from Opportunity%'
  AND created_at > NOW() - INTERVAL '14 days'
GROUP BY status
ORDER BY count DESC;

-- ────────────────────────────────────────────────────────────────────────────
-- What we're looking for in the output:
--
-- Scenario 1: brief_status='draft' + bragi_finished_outline=false
--    → after() never fired generateAgentBrief — confirms maxDuration bug
--    → Fix A will resolve. Recovery: click "Process stuck" after deploy.
--
-- Scenario 2: brief_status='generating' + bragi_finished_outline=false
--    → Bragi started but got killed mid-run (also maxDuration)
--    → Same fix. Recovery: same.
--
-- Scenario 3: brief_status='agent_generated' but opp_status='brief_queued'
--    → Bragi finished, opp.status auto-heal didn't fire
--    → Sonnet's auto-heal in pipeline-journey/route.ts SHOULD catch this on
--      next page load. If still stuck, the issue is in the heal logic.
--
-- Scenario 4: linked_brief_id IS NULL (opp.brief_id null)
--    → INSERT or UPDATE in approve route silently failed
--    → Different bug — would need to check Vercel logs.
--
-- Scenario 5: has_opp_tag=false on linked brief
--    → notes were set without the tag → reverse-lookup breaks → "0 briefs queued"
--    → Need to check what notes value actually got persisted.
-- ────────────────────────────────────────────────────────────────────────────
