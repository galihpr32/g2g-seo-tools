-- Phase 3: Anak Intern + seo_content_briefs enhancements
-- Run this in Supabase SQL Editor

-- 1. Add owner_user_id to seo_content_briefs if missing
--    (allows per-owner scoping; workspace members share the same owner_user_id via RLS)
alter table seo_content_briefs
  add column if not exists owner_user_id uuid references auth.users(id);

-- 2. Add notes column to seo_content_briefs for Anak Intern context
alter table seo_content_briefs
  add column if not exists notes text;

-- 3. Add 'draft' as a valid status (table uses text column so no enum change needed)
--    Ensure the status column exists (it already should)
-- alter table seo_content_briefs add column if not exists status text default 'draft';

-- 4. Index for anak-intern lookups by keyword in page
create index if not exists idx_briefs_page_owner
  on seo_content_briefs(owner_user_id, page);

-- 5. Add approved_by column to agent_actions if missing
alter table agent_actions
  add column if not exists approved_by uuid references auth.users(id);

-- Done!
