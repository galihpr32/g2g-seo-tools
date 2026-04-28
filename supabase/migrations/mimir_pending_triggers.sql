-- Transient table for Mimir agent-trigger confirmation tokens.
-- When Mimir proposes running an agent, it stores a one-time token here.
-- The frontend's "Yes, trigger" button POSTs the token to
-- /api/ai/confirm-agent-run, which validates + fires the run, then
-- deletes the token. Tokens expire after 5 minutes.
--
-- RLS: service_role only — the chat API and confirm endpoint both use
-- createServiceClient(), so regular users never touch this directly.

CREATE TABLE IF NOT EXISTS mimir_pending_triggers (
  token          text PRIMARY KEY,
  owner_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_key      text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mimir_pending_triggers_owner_exp_idx
  ON mimir_pending_triggers (owner_user_id, expires_at);

ALTER TABLE mimir_pending_triggers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_only"
  ON mimir_pending_triggers FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
