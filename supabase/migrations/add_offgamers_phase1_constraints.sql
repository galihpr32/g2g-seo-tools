-- ── OffGamers Phase 1: Fix unique constraints for multi-brand ─────────────────
-- Run AFTER add_offgamers_phase1.sql (which added the site_slug columns).
-- These statements change UNIQUE constraints so G2G and OG can each have their
-- own rows for the same domain in outreach_domain_scores and outreach_prospects.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. outreach_domain_scores ─────────────────────────────────────────────────
-- Old: UNIQUE (owner_user_id, domain)
-- New: UNIQUE (owner_user_id, site_slug, domain)
-- Allows G2G and OG to independently cache scores for the same domain.

ALTER TABLE public.outreach_domain_scores
  DROP CONSTRAINT IF EXISTS outreach_domain_scores_owner_user_id_domain_key;

ALTER TABLE public.outreach_domain_scores
  ADD CONSTRAINT outreach_domain_scores_owner_site_domain_key
  UNIQUE (owner_user_id, site_slug, domain);


-- ── 2. outreach_prospects ─────────────────────────────────────────────────────
-- Old: UNIQUE (owner_user_id, domain)  — only one prospect row per domain
-- New: UNIQUE (owner_user_id, site_slug, domain)
-- Allows G2G and OG to pitch the same domain independently.

-- First, find and drop the existing unique constraint.
-- (Supabase auto-generates the name as <table>_<cols>_key)
ALTER TABLE public.outreach_prospects
  DROP CONSTRAINT IF EXISTS outreach_prospects_owner_user_id_domain_key;

ALTER TABLE public.outreach_prospects
  ADD CONSTRAINT outreach_prospects_owner_site_domain_key
  UNIQUE (owner_user_id, site_slug, domain);
