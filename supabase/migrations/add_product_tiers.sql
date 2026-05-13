-- ── Product Tiers ─────────────────────────────────────────────────────────────
-- Galih's Tier 1 (top 10 per brand) and Tier 2 (next 25 per brand) products.
-- Tier 1+2 = "lab" where we apply hybrid review (AI + human) and aggressive
-- backlink/outreach. Quality standards developed here propagate to the rest
-- via the KB rule extraction system. Everything OUTSIDE these tiers gets the
-- standard auto treatment.
--
-- Identifier strategy: campuran (mixed). One product can be matched by:
--   - relation_id (G2G's internal product ID, same as product_content_queue)
--   - url          (e.g. https://www.g2g.com/categories/albion-online-global-account)
--   - product_name (display label, e.g. "Albion Online Global Account")
--
-- The resolver tries in that order. Tier list is static — Galih uploads once,
-- swaps manually when a product changes priority. No auto-promotion.

create table if not exists public.product_tiers (
  id              uuid primary key default gen_random_uuid(),
  owner_user_id   uuid not null references auth.users(id) on delete cascade,
  /** 'g2g' | 'offgamers' — separate tier list per brand. */
  site_slug       text not null,
  /** 1 (top 10 per brand) or 2 (next 25 per brand). */
  tier            smallint not null check (tier in (1, 2)),
  /** Required — used in admin UI label, fuzzy-match fallback in resolver. */
  product_name    text not null,
  /** Optional — preferred match key when present. Same format as
      product_content_queue.relation_id (UUID-like or numeric string). */
  relation_id     text,
  /** Optional — full product page URL, used for URL-based match. */
  url             text,
  /** Free-form notes — e.g., "high competition niche", "Q4 push target". */
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.product_tiers enable row level security;

create policy "Users manage own product tiers"
  on public.product_tiers for all
  using  (auth.uid() = owner_user_id)
  with check (auth.uid() = owner_user_id);

-- Per-owner+brand+tier listing — primary access pattern for admin page +
-- bulk tier-map loading by Heimdall/Bragi/Tyr/etc.
create index if not exists product_tiers_owner_site_tier_idx
  on public.product_tiers (owner_user_id, site_slug, tier);

-- Resolver match indexes. Partial — only on rows that actually have the key.
create index if not exists product_tiers_relation_id_idx
  on public.product_tiers (owner_user_id, site_slug, relation_id)
  where relation_id is not null;

create index if not exists product_tiers_url_idx
  on public.product_tiers (owner_user_id, site_slug, url)
  where url is not null;

-- Soft-uniqueness — same relation_id within (owner, site) shouldn't appear
-- twice. UI also enforces this on save, but DB is the source of truth.
create unique index if not exists product_tiers_relation_id_unique
  on public.product_tiers (owner_user_id, site_slug, relation_id)
  where relation_id is not null;
