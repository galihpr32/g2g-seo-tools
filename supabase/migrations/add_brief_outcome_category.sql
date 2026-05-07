-- ── Brief outcome auto-category (Sprint 10.1) ──────────────────────────────
-- Closes the OTHER feedback loop besides KB: did the published brief
-- actually move rankings? Cron at +30d compares pos_0 vs pos_30 (and
-- clicks_0 vs clicks_30) and writes a category — no LLM needed, the
-- numbers tell the story.
--
-- Categories:
--   winner   — pos_30 < pos_0 - 3  OR  clicks_30 ≥ 1.5× clicks_0
--   loser    — pos_30 > pos_0 + 3  OR  clicks_30 ≤ 0.7× clicks_0
--   flat     — neither — content shipped but didn't move the needle
--   no_data  — missing pos_30 (GSC didn't index, low impressions)

alter table brief_outcomes
  add column if not exists category_30d        text,
  add column if not exists category_30d_at     timestamptz,
  add column if not exists category_reason     text;

create index if not exists brief_outcomes_category_idx
  on brief_outcomes (owner_user_id, category_30d);
