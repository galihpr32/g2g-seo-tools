-- keyword_exclusions: patterns to filter out from keyword gap analysis
-- Supports manual entries + auto-generated from competitor domains

CREATE TABLE IF NOT EXISTS keyword_exclusions (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id   uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  pattern         text        NOT NULL,
  match_type      text        DEFAULT 'contains' CHECK (match_type IN ('contains', 'exact', 'starts_with')),
  source          text        DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  source_domain   text,       -- populated when source = 'auto' (which competitor domain generated this)
  created_at      timestamptz DEFAULT now(),
  UNIQUE(owner_user_id, pattern)
);

ALTER TABLE keyword_exclusions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own keyword exclusions"
  ON keyword_exclusions FOR ALL
  USING (auth.uid() = owner_user_id);

-- Also update agent_key references in existing data (Norse rename migration)
UPDATE agents       SET agent_key = 'heimdall' WHERE agent_key = 'pak-rt';
UPDATE agents       SET agent_key = 'odin'     WHERE agent_key = 'mas-gacor';
UPDATE agents       SET agent_key = 'loki'     WHERE agent_key = 'intel-bakso';
UPDATE agents       SET agent_key = 'bragi'    WHERE agent_key = 'anak-intern';
UPDATE agents       SET agent_key = 'hermod'   WHERE agent_key = 'kang-cilok';

UPDATE agent_runs   SET agent_key = 'heimdall' WHERE agent_key = 'pak-rt';
UPDATE agent_runs   SET agent_key = 'odin'     WHERE agent_key = 'mas-gacor';
UPDATE agent_runs   SET agent_key = 'loki'     WHERE agent_key = 'intel-bakso';
UPDATE agent_runs   SET agent_key = 'bragi'    WHERE agent_key = 'anak-intern';
UPDATE agent_runs   SET agent_key = 'hermod'   WHERE agent_key = 'kang-cilok';

UPDATE agent_actions SET agent_key = 'heimdall' WHERE agent_key = 'pak-rt';
UPDATE agent_actions SET agent_key = 'odin'     WHERE agent_key = 'mas-gacor';
UPDATE agent_actions SET agent_key = 'loki'     WHERE agent_key = 'intel-bakso';
UPDATE agent_actions SET agent_key = 'bragi'    WHERE agent_key = 'anak-intern';
UPDATE agent_actions SET agent_key = 'hermod'   WHERE agent_key = 'kang-cilok';
