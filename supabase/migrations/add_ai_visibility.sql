-- ─────────────────────────────────────────────────────────────────────────────
-- Frey Agent — AI Visibility Tracking
--
-- Frey weekly queries multiple LLMs (Claude, GPT-4o-mini for MVP) with
-- brand-relevant prompts, parses responses for G2G mention/sentiment/competitor
-- presence, and emits findings + agent_actions to feed pipeline.
--
-- Tables:
--   1. ai_visibility_prompts   — curated prompt library (user-editable)
--   2. ai_visibility_findings  — per-(prompt, LLM, run) result rows
--   3. ai_visibility_snapshots — weekly aggregated score per topic
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Prompts (curated by user, hybrid topic mapping) ──────────────────────
CREATE TABLE IF NOT EXISTS ai_visibility_prompts (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug       text NOT NULL DEFAULT 'g2g',
  prompt_text     text NOT NULL,
  category        text NOT NULL DEFAULT 'general'
    CHECK (category IN ('brand', 'product', 'comparison', 'how_to', 'recommendation', 'general')),
  -- Hybrid topic mapping:
  --   topic_slug         = manual override (nullable, set by user)
  --   auto_topic_slug    = computed at runtime by keyword-overlap match (nullable)
  -- Frey resolves: topic_slug if set, else auto_topic_slug, else NULL (untracked).
  topic_slug      text,
  auto_topic_slug text,
  active          boolean DEFAULT true,
  created_at      timestamptz DEFAULT now() NOT NULL,
  updated_at      timestamptz DEFAULT now() NOT NULL,

  UNIQUE (owner_user_id, site_slug, prompt_text)
);

CREATE INDEX IF NOT EXISTS ai_visibility_prompts_owner_active_idx
  ON ai_visibility_prompts (owner_user_id, site_slug, active)
  WHERE active = true;

-- ── 2. Findings (raw per-prompt × LLM × run results) ─────────────────────────
CREATE TABLE IF NOT EXISTS ai_visibility_findings (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug           text NOT NULL DEFAULT 'g2g',
  run_id              uuid NOT NULL,                   -- groups one Frey run
  prompt_id           uuid NOT NULL REFERENCES ai_visibility_prompts(id) ON DELETE CASCADE,
  llm_platform        text NOT NULL
    CHECK (llm_platform IN ('claude', 'gpt-4o-mini', 'perplexity-sonar', 'gemini-flash')),
  brand_mentioned     boolean NOT NULL,
  brand_position      integer,                         -- 1=first, 2=second, NULL=not mentioned
  sentiment           numeric(3, 2),                   -- -1.00 to +1.00
  competitors         jsonb DEFAULT '[]'::jsonb,       -- [{domain, position, mentions}]
  raw_response        text,                            -- full LLM response for audit
  parser_notes        text,                            -- what the Haiku parser noticed
  observed_at         timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_visibility_findings_run_idx
  ON ai_visibility_findings (run_id);

CREATE INDEX IF NOT EXISTS ai_visibility_findings_prompt_observed_idx
  ON ai_visibility_findings (prompt_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS ai_visibility_findings_owner_observed_idx
  ON ai_visibility_findings (owner_user_id, site_slug, observed_at DESC);

-- ── 3. Snapshots (weekly aggregated score per topic) ─────────────────────────
CREATE TABLE IF NOT EXISTS ai_visibility_snapshots (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  site_slug           text NOT NULL DEFAULT 'g2g',
  topic_slug          text,                            -- nullable: '__overall__' for site-wide
  week_starting       date NOT NULL,                   -- always Monday of the week
  visibility_score    numeric(5, 2),                   -- 0-100 composite
  mention_rate        numeric(5, 4),                   -- % prompts where mentioned (0-1)
  avg_position        numeric(4, 2),                   -- across mentioned prompts only
  avg_sentiment       numeric(3, 2),                   -- -1 to +1
  prompt_coverage     integer NOT NULL DEFAULT 0,      -- # prompts in this topic this week
  llm_breakdown       jsonb DEFAULT '{}'::jsonb,       -- per-LLM scores
  top_competitor      text,                            -- domain that dominated this week
  created_at          timestamptz DEFAULT now() NOT NULL,

  UNIQUE (owner_user_id, site_slug, COALESCE(topic_slug, '__overall__'), week_starting)
);

CREATE INDEX IF NOT EXISTS ai_visibility_snapshots_owner_week_idx
  ON ai_visibility_snapshots (owner_user_id, site_slug, week_starting DESC);

CREATE INDEX IF NOT EXISTS ai_visibility_snapshots_topic_week_idx
  ON ai_visibility_snapshots (topic_slug, week_starting DESC)
  WHERE topic_slug IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: 30 starter prompts for G2G (placeholder — user edits later)
-- These are based on G2G's actual content topics and competitor landscape.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  owner_id uuid;
BEGIN
  -- Pick the most likely owner (galih.priambodo@g2g.com) for the seed.
  -- If not found, skip seeding (will run when first proper user signs up).
  SELECT id INTO owner_id FROM auth.users
  WHERE email = 'galih.priambodo@g2g.com'
  LIMIT 1;

  IF owner_id IS NULL THEN
    RAISE NOTICE 'No auth.users row for galih.priambodo@g2g.com — skipping prompt seed';
    RETURN;
  END IF;

  -- Insert 30 prompts spanning common AI-search categories. ON CONFLICT DO NOTHING
  -- means re-running this migration is safe.
  INSERT INTO ai_visibility_prompts (owner_user_id, site_slug, prompt_text, category, topic_slug) VALUES
    -- Brand awareness (5)
    (owner_id, 'g2g', 'What is G2G and is it safe to use?', 'brand', NULL),
    (owner_id, 'g2g', 'Is G2G a legit marketplace for gaming items?', 'brand', NULL),
    (owner_id, 'g2g', 'How does G2G escrow service work?', 'brand', NULL),
    (owner_id, 'g2g', 'G2G review — is it trustworthy?', 'brand', NULL),
    (owner_id, 'g2g', 'How to buy game accounts on G2G safely', 'brand', NULL),

    -- MMO / RPG (where G2G is strong) (5)
    (owner_id, 'g2g', 'Where can I buy WoW gold safely?', 'recommendation', NULL),
    (owner_id, 'g2g', 'Best place to buy OSRS gold without ban', 'recommendation', NULL),
    (owner_id, 'g2g', 'Trusted marketplace for Final Fantasy XIV gil', 'recommendation', NULL),
    (owner_id, 'g2g', 'Best site to buy Lost Ark gold', 'recommendation', NULL),
    (owner_id, 'g2g', 'Where to sell my MMO account safely', 'recommendation', NULL),

    -- Modern game accounts/items (mixed visibility) (5)
    (owner_id, 'g2g', 'Best marketplace for Diablo 4 items', 'recommendation', NULL),
    (owner_id, 'g2g', 'Where to buy Marvel Rivals account', 'recommendation', NULL),
    (owner_id, 'g2g', 'Trusted site for Genshin Impact accounts', 'recommendation', NULL),
    (owner_id, 'g2g', 'Best place to buy Roblox Robux with discount', 'recommendation', NULL),
    (owner_id, 'g2g', 'Where can I buy Fortnite V-Bucks cheap', 'recommendation', NULL),

    -- Comparison queries (5)
    (owner_id, 'g2g', 'G2G vs PlayerAuctions — which is better?', 'comparison', NULL),
    (owner_id, 'g2g', 'Compare G2G and Eneba for gaming purchases', 'comparison', NULL),
    (owner_id, 'g2g', 'Best alternative to PlayerAuctions', 'comparison', NULL),
    (owner_id, 'g2g', 'G2G vs Kinguin for game keys', 'comparison', NULL),
    (owner_id, 'g2g', 'Sites like PlayerAuctions for gaming services', 'comparison', NULL),

    -- Top-up / gift cards (5)
    (owner_id, 'g2g', 'Where to buy Steam Wallet gift cards online', 'product', NULL),
    (owner_id, 'g2g', 'Best site for Mobile Legends top-up', 'product', NULL),
    (owner_id, 'g2g', 'Where to buy Apple gift cards with discount', 'product', NULL),
    (owner_id, 'g2g', 'Trusted site for PUBG Mobile UC top-up', 'product', NULL),
    (owner_id, 'g2g', 'Where to buy YouTube Premium account', 'product', NULL),

    -- How-to & service queries (5)
    (owner_id, 'g2g', 'How to safely sell my game account online', 'how_to', NULL),
    (owner_id, 'g2g', 'How to avoid scams when buying gaming accounts', 'how_to', NULL),
    (owner_id, 'g2g', 'How does peer-to-peer gaming marketplace work', 'how_to', NULL),
    (owner_id, 'g2g', 'Best gaming boosting service marketplace', 'recommendation', NULL),
    (owner_id, 'g2g', 'Where to find game power leveling services', 'how_to', NULL)
  ON CONFLICT (owner_user_id, site_slug, prompt_text) DO NOTHING;

  RAISE NOTICE 'Seeded ai_visibility_prompts for owner %', owner_id;
END $$;

-- Verify (run manually):
-- SELECT category, COUNT(*) FROM ai_visibility_prompts GROUP BY category ORDER BY 2 DESC;
