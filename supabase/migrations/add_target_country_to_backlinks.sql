-- Add target_country to paid_backlinks
-- Stores the country/market this backlink was placed in (e.g. 'id', 'sg', 'us')
alter table public.paid_backlinks
  add column if not exists target_country text not null default 'global';

create index if not exists paid_backlinks_country_idx
  on public.paid_backlinks (owner_user_id, target_country);
