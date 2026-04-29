-- ────────────────────────────────────────────────────────────────────────────
-- Recovery: reset 7 stuck opps back to 'new' so user can re-approve them
-- via the UI. Run AFTER all the approve-route + process-briefs patches are
-- deployed, so the new approve flow processes them correctly.
--
-- These 7 opps were left at status='brief_queued' with brief_id=NULL because:
--   1. The pipeline-journey GET errored on word_count_target column → UI never
--      reflected actual brief state (now fixed).
--   2. Even after the SELECT was fixed, these 7 had NO brief at all (briefly
--      INSERT failed during one of Sonnet's earlier sessions, root cause
--      unconfirmed — captured by new approve-route error logging).
--
-- The cleanest recovery: reset them to 'new' so they show up as "Need Action"
-- in pipeline UI again, then user re-approves with the patched flow.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE seo_opportunities
SET
  status      = 'new',
  brief_id    = NULL,
  output_type = NULL,
  updated_at  = NOW()
WHERE id IN (
  'ca271d8b-dec8-4be0-b99c-4dd451d09676', -- Diablo Immortal Account
  'dfabe39a-4099-4519-9854-5ab0be610590', -- Carx Street Accounts
  '4d9e96bf-fc61-422c-a267-78c53d9db8b5', -- Hero Siege Ruby
  'b4684a74-04d9-4cc1-a1d2-4aeb5191af09', -- Kingshot Accounts
  'ba938728-4566-4835-a8c7-a25c23a68973', -- Rise Of Civilizations Account
  '09d50efe-8456-4667-8297-5f4b3aa9f627', -- Rocket League Item
  '4551c27f-1de3-4921-a5a8-6dc3cfb9ce25'  -- Marvel Rivals Accounts
)
AND status = 'brief_queued'   -- safety: only reset if still stuck
RETURNING id, topic, status;

-- Expected output: 7 rows, all with status='new'.
-- After running this, refresh /command-center/pipeline. The 7 will show in
-- "Need Action" tab. Approve them one by one (or pick brief types) and watch
-- them flow through. With the patches applied:
--   - approve route returns insertErrors[] in body if any INSERT fails
--   - first brief fires after() with maxDuration=60
--   - process-briefs picks up the rest within ~30s on next GH Actions run
--     (every 10 min) or via "⚡ Process stuck" manual button
