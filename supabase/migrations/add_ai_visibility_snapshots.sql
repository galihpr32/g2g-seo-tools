-- Sprint FREYJA — AI Visibility tracker.
--
-- Freyja in Norse myth = goddess of seiðr (divination); she wears a falcon
-- cloak and sees what others can't. Different domain from Odin (ground-level
-- intel via ravens) — Freyja sees the unseen patterns.
--
-- This table stores per-day snapshots of how a brand appears across LLMs
-- and AI-driven search surfaces. Sources are mixed: some come from APIs
-- (Bing Webmaster AI Performance when available), some from manual CSV/JSON
-- upload by the SEO lead pulling Semrush AI Visibility weekly.
--
-- Why generic shape (one row per llm_source × country × date) rather than
-- wide columns: future-proof. Adding a new LLM (Claude in Chrome, Perplexity,
-- You.com) is just a new value in llm_source, no schema change.

CREATE TABLE IF NOT EXISTS public.ai_visibility_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    uuid NOT NULL,
  site_slug        text NOT NULL,
  snapshot_date    date NOT NULL,

  -- llm_source values (expand freely; not a CHECK constraint so new platforms
  -- can be added without migration):
  --   'bing_ai'             — Bing Webmaster AI Performance (Copilot + partners)
  --   'semrush_overall'     — Semrush AI Visibility overall score
  --   'chatgpt'             — Semrush breakdown: OpenAI ChatGPT
  --   'gemini'              — Semrush breakdown: Google Gemini app
  --   'ai_mode'             — Semrush breakdown: Google AI Mode
  --   'ai_overview'         — Semrush breakdown: Google AI Overview (SERP)
  --   'perplexity'          — future
  --   'claude'              — future (Claude in Chrome)
  llm_source       text NOT NULL,

  -- country code (alpha-2 lowercase, e.g. 'us', 'id'); 'global' = all combined
  country          text DEFAULT 'global',

  -- The 3 standard metrics we surface from both Bing and Semrush.
  -- Mentions   = times brand was mentioned in AI response
  -- Citations  = times brand was cited as a source (linked back)
  -- Cited pages = distinct URLs cited
  -- Different sources count differently; we trust each source's own definition.
  mentions         integer DEFAULT 0,
  citations        integer DEFAULT 0,
  cited_pages      integer DEFAULT 0,

  -- How this row got created
  source           text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'csv', 'bing_api', 'semrush_api')),

  -- Free-form JSON for source-specific extras (Semrush gives audience size,
  -- Bing gives query breakdown, etc.). Keeps the core schema lean.
  metadata         jsonb,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: re-uploading same date × llm × country overrides.
  UNIQUE (owner_user_id, site_slug, snapshot_date, llm_source, country)
);

CREATE INDEX IF NOT EXISTS ai_visibility_owner_site_date_idx
  ON public.ai_visibility_snapshots (owner_user_id, site_slug, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS ai_visibility_llm_source_idx
  ON public.ai_visibility_snapshots (llm_source);

COMMENT ON TABLE public.ai_visibility_snapshots IS
  'Sprint FREYJA — Per-day AI visibility snapshots across LLMs (Bing AI, Semrush breakdown, future Perplexity/Claude). One row per (date × llm_source × country). Re-imports of same key override.';
