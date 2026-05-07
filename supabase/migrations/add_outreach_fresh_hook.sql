-- ── Outreach fresh-hook column ──────────────────────────────────────────────
-- Sprint 9.2: Bifrost newsjacking classifier writes a JSONB hook here when
-- it spots a newsjackable angle for an active prospect. UI surfaces the
-- hook_summary inline + links to the news article.
--
-- Schema of fresh_hook JSONB:
--   {
--     "news_item_id": "...",
--     "news_url":     "...",
--     "title":        "...",
--     "game_name":    "WoW",
--     "news_type":    "release",
--     "hook_summary": "<Haiku one-liner>",
--     "matched_at":   "2026-05-08T...Z"
--   }

alter table public.outreach_prospects
  add column if not exists fresh_hook jsonb;

create index if not exists outreach_prospects_fresh_hook_idx
  on public.outreach_prospects (owner_user_id)
  where fresh_hook is not null;
