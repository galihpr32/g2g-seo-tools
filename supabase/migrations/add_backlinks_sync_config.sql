-- Sprint #387 BACKLINKS.SHEET.SYNC ─────────────────────────────────────────
-- Stores per-(owner, site_slug) Google Sheet "Publish to web → CSV" URL +
-- the last sync attempt result. One row per (owner, site_slug). The Sync
-- Now button on /backlinks reads `sheet_url`, fetches it server-side,
-- parses the CSV, appends new rows to `paid_backlinks` (skip if
-- external_url already exists for the same owner+site).

create table if not exists public.backlinks_sync_config (
  id                    uuid primary key default gen_random_uuid(),
  owner_user_id         uuid not null references auth.users(id) on delete cascade,
  site_slug             text not null default 'g2g',

  -- Sheet "Publish to web → CSV" URL. Must be public-readable; we fetch
  -- as anonymous server-side. https://docs.google.com/spreadsheets/.../pub?...&output=csv
  sheet_url             text not null,

  -- Last sync attempt metadata (overwritten each run)
  last_synced_at        timestamptz,
  last_sync_rows_added  int,         -- NEW rows inserted
  last_sync_rows_skipped int,        -- existing rows skipped (dedup by external_url)
  last_sync_rows_errored int,        -- rows that failed validation (bad URL, missing required field)
  last_sync_error       text,        -- top-level error string if the whole sync failed

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (owner_user_id, site_slug)
);

create index if not exists backlinks_sync_config_owner_idx
  on public.backlinks_sync_config (owner_user_id, site_slug);

-- RLS
alter table public.backlinks_sync_config enable row level security;

create policy "Users can manage their own sync config"
  on public.backlinks_sync_config
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- Reuse the shared updated_at trigger function (added in add_paid_backlinks.sql)
create trigger backlinks_sync_config_updated_at
  before update on public.backlinks_sync_config
  for each row execute function public.handle_updated_at();
