-- keyword_gap_snapshots: persists keyword gap analysis results per run
-- So users can reload past analyses without re-fetching from DataForSEO

CREATE TABLE IF NOT EXISTS keyword_gap_snapshots (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id    uuid        REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  competitor_domain text       NOT NULL,
  location_code    integer,
  language_code    text,
  summary          jsonb       NOT NULL DEFAULT '{}',
  gaps             jsonb       NOT NULL DEFAULT '[]',
  behind           jsonb       NOT NULL DEFAULT '[]',
  winning          jsonb       NOT NULL DEFAULT '[]',
  excluded_count   integer     DEFAULT 0,
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX idx_gap_snapshots_owner ON keyword_gap_snapshots(owner_user_id, created_at DESC);

ALTER TABLE keyword_gap_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own gap snapshots"
  ON keyword_gap_snapshots FOR ALL
  USING (auth.uid() = owner_user_id);
