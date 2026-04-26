-- Add an explicit CHECK constraint on agent_runs.status so invalid values
-- are rejected by the DB instead of silently stored.
--
-- Allowed values:
--   running               — initial state when run is created
--   success               — agent finished cleanly, all data sources OK
--   partial               — agent finished but with warnings (e.g. external
--                           API degraded, some inserts failed); see error_message
--   error                 — agent threw / aborted; see error_message
--   pending_implementation — legacy value used by the old executor for
--                           handoffs to non-implemented agents. Kept to avoid
--                           breaking historical rows in production. (Current
--                           executor does not write this anymore — handoffs
--                           are now rejected with a 4xx instead.)
--
-- The constraint is added AFTER coercing any unexpected legacy values to
-- 'error', so existing rows don't break the constraint.

-- 1. Heal any rows whose status doesn't match the allowed set
UPDATE agent_runs
   SET status = 'error',
       error_message = COALESCE(error_message, '') || ' [healed: invalid status "' || status || '"]'
 WHERE status IS NOT NULL
   AND status NOT IN ('running', 'success', 'partial', 'error', 'pending_implementation');

-- 2. Drop the constraint if it exists (idempotent re-run)
ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_status_check;

-- 3. Re-add with the canonical set
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('running', 'success', 'partial', 'error', 'pending_implementation'));

-- 4. Same hardening on agents.last_run_status (mirrors agent_runs.status,
--    written by every agent's _finishRun helper).
UPDATE agents
   SET last_run_status = 'error'
 WHERE last_run_status IS NOT NULL
   AND last_run_status NOT IN ('running', 'success', 'partial', 'error', 'pending_implementation');

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_last_run_status_check;

ALTER TABLE agents
  ADD CONSTRAINT agents_last_run_status_check
  CHECK (last_run_status IS NULL
         OR last_run_status IN ('running', 'success', 'partial', 'error', 'pending_implementation'));
