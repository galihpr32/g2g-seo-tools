-- ============================================================
-- Knowledge Base
-- Stores brand context, product categories, and platform rules
-- that get injected into all AI content generation.
-- ============================================================

-- ── knowledge_base_items ──────────────────────────────────────────────────────
-- category: 'brand' | 'category' | 'platform'
-- data structure per category:
--   brand:    { tone, audience, dos, donts, notes }
--   category: { description, buyer_intent, keywords, angle, notes }
--   platform: { writing_rules, format, tone, dos, donts, notes }
CREATE TABLE IF NOT EXISTS knowledge_base_items (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('brand', 'category', 'platform')),
  name          text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz DEFAULT now() NOT NULL,
  updated_at    timestamptz DEFAULT now() NOT NULL,
  UNIQUE (owner_user_id, category, name)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_base_owner_category
  ON knowledge_base_items (owner_user_id, category);

ALTER TABLE knowledge_base_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_base_items: owner full access"
  ON knowledge_base_items FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

DROP TRIGGER IF EXISTS knowledge_base_items_updated_at ON knowledge_base_items;
CREATE TRIGGER knowledge_base_items_updated_at
  BEFORE UPDATE ON knowledge_base_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── dmca_terms ─────────────────────────────────────────────────────────────────
-- original_term: the word to avoid in on-page content
-- replacement_term: what to use instead
CREATE TABLE IF NOT EXISTS dmca_terms (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  original_term    text NOT NULL,
  replacement_term text NOT NULL,
  notes            text,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz DEFAULT now() NOT NULL,
  UNIQUE (owner_user_id, original_term)
);

CREATE INDEX IF NOT EXISTS idx_dmca_terms_owner
  ON dmca_terms (owner_user_id, active);

ALTER TABLE dmca_terms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dmca_terms: owner full access"
  ON dmca_terms FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());

-- ── dmca_hits ──────────────────────────────────────────────────────────────────
-- Records which published briefs contain flagged DMCA terms.
-- Populated by /api/dmca/scan endpoint.
CREATE TABLE IF NOT EXISTS dmca_hits (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_id      uuid NOT NULL REFERENCES seo_content_briefs(id) ON DELETE CASCADE,
  dmca_term_id  uuid NOT NULL REFERENCES dmca_terms(id) ON DELETE CASCADE,
  detected_at   timestamptz DEFAULT now() NOT NULL,
  resolved      boolean NOT NULL DEFAULT false,
  resolved_at   timestamptz,
  UNIQUE (brief_id, dmca_term_id)
);

CREATE INDEX IF NOT EXISTS idx_dmca_hits_owner_resolved
  ON dmca_hits (owner_user_id, resolved);

CREATE INDEX IF NOT EXISTS idx_dmca_hits_brief
  ON dmca_hits (brief_id);

ALTER TABLE dmca_hits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "dmca_hits: owner full access"
  ON dmca_hits FOR ALL
  USING  (owner_user_id = auth.uid())
  WITH CHECK (owner_user_id = auth.uid());
