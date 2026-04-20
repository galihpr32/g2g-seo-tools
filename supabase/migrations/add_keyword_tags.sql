-- ── Keyword Category Tags ─────────────────────────────────────────────────────
-- Maps a keyword (from SEMrush / GSC) to one of the KB category names.
-- One tag per keyword per owner (unique constraint enforces this).

create table if not exists public.keyword_tags (
  id            uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  keyword       text not null,
  category_name text not null,   -- matches knowledge_base_items.name where category='category'
  created_at    timestamptz not null default now(),
  unique (owner_user_id, keyword)
);

alter table public.keyword_tags enable row level security;

create policy "keyword_tags: owner full access"
  on public.keyword_tags for all
  using  (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create index if not exists keyword_tags_owner_idx
  on public.keyword_tags (owner_user_id);
