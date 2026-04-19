-- API Usage Logs
-- Tracks every outbound API call made by the app per user/feature
create table if not exists public.api_usage_logs (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,

  api_name        text not null,   -- 'dataforseo' | 'semrush' | 'firecrawl' | 'claude'
  endpoint        text,            -- e.g. 'serp/organic', 'domain_overview', 'scrape'
  call_count      integer not null default 1,
  triggered_by    text,            -- 'brief_generate' | 'url_analysis' | 'backlink_refresh' | 'backlink_check' | 'brief_draft'
  metadata        jsonb not null default '{}',  -- e.g. { keyword, url, backlink_count }

  created_at      timestamptz not null default now()
);

-- Indexes
create index if not exists api_usage_logs_owner_idx   on public.api_usage_logs(owner_user_id);
create index if not exists api_usage_logs_created_idx on public.api_usage_logs(created_at);
create index if not exists api_usage_logs_api_idx     on public.api_usage_logs(api_name);

-- RLS
alter table public.api_usage_logs enable row level security;

create policy "Users can view and insert their own logs"
  on public.api_usage_logs
  for all
  using  (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
