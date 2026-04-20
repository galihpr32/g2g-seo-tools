-- ── keyword_intents ───────────────────────────────────────────────────────────
-- Cache table for Claude-classified keyword search intents.
-- I = Informational  C = Commercial
-- N = Navigational   T = Transactional

CREATE TABLE IF NOT EXISTS public.keyword_intents (
  keyword        text        PRIMARY KEY,
  intent         text        NOT NULL CHECK (intent IN ('I', 'N', 'C', 'T')),
  classified_at  timestamptz DEFAULT now()
);

ALTER TABLE public.keyword_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read keyword_intents"
  ON public.keyword_intents FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can upsert keyword_intents"
  ON public.keyword_intents FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update keyword_intents"
  ON public.keyword_intents FOR UPDATE TO authenticated USING (true);
