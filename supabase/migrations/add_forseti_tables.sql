-- Sprint FORSETI — Community response tracker for Reddit subreddits.
--
-- Three tables:
--   1. forseti_subreddit_configs — what subs to monitor per (owner × site)
--   2. forseti_threads           — each Reddit thread we've spotted
--   3. forseti_thread_responses  — each team action taken on a thread
--
-- Multi-subreddit from day 1. Reddit thread IDs (e.g. t3_xxx) are globally
-- unique so dedup is simple. Manual override flags prevent the scraper from
-- clobbering team edits to category/severity on re-poll.

-- ─── 1. Subreddit configs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forseti_subreddit_configs (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id       uuid           NOT NULL,
  site_slug           text           NOT NULL,         -- 'g2g' | 'offgamers' — site assignment
  subreddit           text           NOT NULL,         -- 'G2G_com' (without 'r/' prefix)
  enabled             boolean        NOT NULL DEFAULT true,

  -- Optional: only fetch posts containing one of these keywords (case-insensitive).
  -- Use for big general subs (r/MMORPG, r/gaming) where most posts aren't about us.
  -- Comma-separated tokens; empty = fetch all.
  keyword_filter      text           DEFAULT '',

  -- 'small_sub'  → sev5 at 20+upvotes / 15+comments
  -- 'big_sub'    → sev5 at 50+upvotes / 30+comments
  -- 'custom'     → use the override columns below
  severity_preset     text           NOT NULL DEFAULT 'small_sub',
  sev5_min_upvotes    integer,                          -- nullable; populated when preset='custom'
  sev4_min_upvotes    integer,
  sev5_min_comments   integer,
  sev4_min_comments   integer,

  -- Health state. 'ok' | 'error' | 'paused'. Mirrors enabled, but captures
  -- transient scraper errors (403 quarantined, 404 missing sub, etc.).
  status              text           NOT NULL DEFAULT 'ok',
  last_error          text,
  last_polled_at      timestamptz,
  last_polled_threads integer        NOT NULL DEFAULT 0,
  total_threads       integer        NOT NULL DEFAULT 0,

  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT forseti_configs_unique_per_owner UNIQUE (owner_user_id, subreddit)
);

CREATE INDEX IF NOT EXISTS idx_forseti_configs_owner_enabled
  ON forseti_subreddit_configs (owner_user_id, enabled) WHERE enabled = true;

-- ─── 2. Threads ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forseti_threads (
  id                          uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id               uuid           NOT NULL,
  site_slug                   text           NOT NULL,
  config_id                   uuid           REFERENCES forseti_subreddit_configs(id) ON DELETE SET NULL,

  -- Reddit's globally-unique thread ID (e.g. '1abcdef'). Dedup key.
  reddit_id                   text           NOT NULL,
  reddit_url                  text           NOT NULL,
  subreddit                   text           NOT NULL,
  thread_title                text           NOT NULL,
  thread_permalink            text,
  op_username                 text,
  op_post_score               integer        NOT NULL DEFAULT 0,        -- upvotes
  op_comment_count            integer        NOT NULL DEFAULT 0,
  op_post_body                text,                                     -- snippet, capped ~4000 chars
  op_post_at                  timestamptz,                              -- when OP posted on Reddit

  -- Sprint FORSETI — auto vs manual classification.
  -- The scraper writes auto_* on every poll. If a team member sets the
  -- manual_*_override flag, the auto values are ignored in the UI and the
  -- scraper preserves the manual override.
  auto_category               text           NOT NULL DEFAULT 'other',
  manual_category_override    text,                                     -- nullable; null = use auto
  auto_severity               integer        NOT NULL DEFAULT 2 CHECK (auto_severity BETWEEN 1 AND 5),
  manual_severity_override    integer        CHECK (manual_severity_override IS NULL OR manual_severity_override BETWEEN 1 AND 5),

  -- Workflow status. Drives queue tab routing in /forseti.
  status                      text           NOT NULL DEFAULT 'spotted',
  -- spotted | drafted | sent | op_replied | resolved | escalated | ignored | deleted_by_op

  assignee_user_id            uuid,
  assigned_at                 timestamptz,
  responded_at                timestamptz,                              -- when status first → sent
  resolved_at                 timestamptz,                              -- when status → resolved/escalated

  first_seen_at               timestamptz    NOT NULL DEFAULT now(),
  last_synced_at              timestamptz    NOT NULL DEFAULT now(),
  deleted_by_op               boolean        NOT NULL DEFAULT false,    -- set when Reddit returns 404 on re-poll

  created_at                  timestamptz    NOT NULL DEFAULT now(),
  updated_at                  timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT forseti_threads_unique_per_owner UNIQUE (owner_user_id, reddit_id)
);

CREATE INDEX IF NOT EXISTS idx_forseti_threads_owner_status
  ON forseti_threads (owner_user_id, site_slug, status);
CREATE INDEX IF NOT EXISTS idx_forseti_threads_owner_assignee
  ON forseti_threads (owner_user_id, assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_forseti_threads_owner_subreddit
  ON forseti_threads (owner_user_id, subreddit);
CREATE INDEX IF NOT EXISTS idx_forseti_threads_first_seen
  ON forseti_threads (owner_user_id, first_seen_at DESC);

-- ─── 3. Responses + activity log ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forseti_thread_responses (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id           uuid           NOT NULL REFERENCES forseti_threads(id) ON DELETE CASCADE,
  owner_user_id       uuid           NOT NULL,

  -- 'reply'        = response posted to Reddit
  -- 'internal_note'= ops note that doesn't go on Reddit (e.g. "OP DM'd me")
  -- 'escalation'   = handed off to CS or ops team
  -- 'status_change'= activity-log entry for status transitions (auto-generated)
  response_type       text           NOT NULL DEFAULT 'reply',

  response_text       text,                                  -- the actual copy
  response_url        text,                                  -- link to Reddit comment after posting
  outcome_note        text,                                  -- "OP edited post" / "still pissed" / etc.

  posted_by_user_id   uuid,                                  -- which team member
  status_before       text,                                  -- for status_change rows
  status_after        text,

  created_at          timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forseti_responses_thread
  ON forseti_thread_responses (thread_id, created_at DESC);

-- ─── Comments ────────────────────────────────────────────────────────────────
COMMENT ON TABLE  forseti_subreddit_configs IS 'Sprint FORSETI — which subreddits to monitor per (owner × site)';
COMMENT ON TABLE  forseti_threads           IS 'Sprint FORSETI — Reddit threads spotted by scraper or added manually';
COMMENT ON TABLE  forseti_thread_responses  IS 'Sprint FORSETI — team actions taken on a thread (replies, status changes, notes)';

COMMENT ON COLUMN forseti_threads.manual_category_override
  IS 'When set, UI uses this instead of auto_category. Scraper preserves it on re-poll.';
COMMENT ON COLUMN forseti_threads.manual_severity_override
  IS 'When set, UI uses this instead of auto_severity. Scraper preserves it on re-poll.';
