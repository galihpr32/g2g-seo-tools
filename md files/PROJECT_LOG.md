# G2G SEO Ops Platform — Project Log

> Snapshot date: 2026-05-16 (Friday, Week 19)
> 190 sprints shipped to date. Compiled for session-handoff persistence.

---

## High-level architecture

**Stack**
- Next.js 16 App Router on Vercel Hobby + GitHub Actions cron
- Supabase Postgres with RLS, service_role pattern
- Anthropic Claude SDK (Opus 4 for T1, Sonnet 4 for T0/T2, Haiku 4.5 for translation/extraction)
- DataForSEO Live SERP (US, ID markets active per MARKETS.PRUNE)
- Slack via routing config + brand-aware webhooks
- GSC + GA4 integrations (per-owner OAuth)
- Two brands: G2G + OffGamers (multi-tenant via `site_slug`)

**Cron infrastructure** (.github/workflows/)
- gsc-daily — daily 02:00 UTC; tier-aware ranking alerts (T1 DoD, others WoW with 4-day lag)
- tier-serp-weekly — Monday 02:00 UTC; SERP snapshots per (product × keyword × market)
- tier-weekly-summary — Slack tier ranking summary
- weekly-report-generator — Monday 01:00 UTC; PPTX + public link + Slack
- agent-performance-weekly — agent metrics
- frey-weekly — pricing intel
- learning-aggregator-weekly — learning loop rollup
- news-export-weekly — Monday 01:00 UTC; sheet export
- bifrost-news / bifrost-newsjacking — news + opportunity detection
- product-content-auto — 5-min cron for Anthropic-routed product content
- tech-escalation — Monday weekly tech-debt digest
- cost-alert-daily — daily 06:00 UTC; Anthropic spend monitor
- friday-kpi — Friday 08:00 UTC (15:00 WIB); combined G2G+OG KPI digest
- + ~20 more (psi-monthly, kb-rule-extraction, opportunities-snooze, outreach-followup, etc.)

---

## Sprint history by epic

### Tier system foundations
- **A.8** — category column on product_tiers + filter + table grouping
- **A.9** — per-category tier caps (10/25 each)
- **KR.1-12** — tier_keywords + tier_serp_snapshots, DataForSEO SERP wrapper, keyword CRUD, weekly cron, daily Slack alert, detail page, rankings dashboard API + UI
- **UX.1-4** — expandable per-product rows, chart hover tooltips
- **CATALOG.1-14** — g2g_products canonical table, CSV import, admin UI, fuzzy mapping, KB unification
- **UNIFY.1-6** — KB-catalog category unification (single source of truth for category names)
- **TIER.PER.MARKET** — per-market tier rows (US tier 1 ≠ ID tier 1), 7 sub-sprints
- **TIER.PER.MARKET.KW** — per-keyword language UI on /priority-products/[id]: language picker, badge, filter, leaderboard cleanup (3 sub-sprints)
- **FRIDAY.KPI.ROUTING** — bug fix: friday_kpi notification type was missing from /settings/slack-routing UI + validation whitelist

### Content / Brief pipeline
- **PC.1-12** — structured content columns (JSONB), sheet writer (33-col), ID tab auto-create, process.ts rewrite, cron entry, parse error fixes
- **BRAGI.1-10** — outputType plumbing, new-page / blog-post / on-page prompt builders, pipeline router, diff-style optimize, KB hard enforcement, category-aware kw filtering, trend signal surfacing
- **BRAGI.MODEL.TIER** — per-tier model routing (Opus T1, Sonnet T0/T2, Haiku translation)
- **BRAGI.ID.NATIVE** — 50/50 A/B test ID-native vs EN-translate; deterministic hash split; combined metric scoring
- **OPS.CLEAR** — clear-all opportunities + briefs endpoint

### Mimir (memory layer)
- **MIMIR.1-10** — mimir_memories table, extractor, retriever, chat hook, admin UI, sidebar link, auto-seed from tier+KB+outcomes, seed API, lint
- **MIMIR.LEARN** — learning gaps dashboard
- **MIMIR.MARKET** — market column on memories (ID-native scoping)
- **MIMIR.ONPAGE** — on-page pattern learner (6 dimensions, multi-select, progress UI, replace strategy)

### Notifications + monitoring
- **NOTI.1-4** — weekly tier ranking summary Slack cron, PPTX export, Slack delivery
- **CMS.1-6** — cms_tokens, CMS API library, token storage UI, processProductRow integration, JWT-expired alert
- **TECH.REALTIME** — real-time tech-debt INSERT alert + Monday weekly digest
- **ALLCLEAR** — all-clear Slack notifications when no fires
- **FORCE-FIRE.FIX** — honest interpreter + gsc_daily slack_posted accuracy
- **MULTI.1-6** — slack_routing_config table + per-brand × per-type webhook resolution
- **OG.SLACK.FIX** — per-brand Slack separation + dedupe
- **COST.ALERT** — daily Anthropic spend Slack alert ($28 warn / $35 critical, idempotent per month)
- **GSC.T1.DOD** — Tier 1 day-over-day ≥10% / others WoW ≥15% with 4-day GSC lag
- **MARKETS.PRUNE** — DataForSEO scoped to US+ID; keyword.language column; per-language market filtering

### News + trends
- **NEWS_EXPORT.1-17** — news_export_config, sheet exporter (Article × Game, Game Rollup, Game Trends), Tier × News Overlap, Haiku keyword extractor, weekly cron
- **NEWS_UI.1-5** — tier overlap API + pinned section, game rollup cards, article timeline, tier badge on /content/trends

### Reports + dashboards
- **PRESENT.1-14** — agent-performance lib + API + page, weekly digest Slack, rollout-impact, content-economics, tyr_autopublish_config, auto-approve hook, admin UI, manual flow audit doc, backlink impact doc
- **LEARN.1-8** — brief_review_feedback table, diff capture, reason prompt UI, Haiku reason classifier, weekly aggregator, autopublish threshold recommender, learning-loop dashboard
- **WEEKLY.PUBLIC** — public weekly report (Option A)
- **METHODOLOGY** — competitive-keyword methodology page (SV × density × intent) + doc
- **FRIDAY.KPI.INFRA** — notification_type / search_volume / intent columns on seo_action_items
- **FRIDAY.KPI** — Friday digest cron + manual trigger + Slack (rebuilt to KPI dashboard format)

### Off-page
- **OFFPAGE.1** — dedicated off-page command center
- **DEBUG.1** — Hermod + Backlink Gap investigation
- **PASTE_MATCH.1-4** — name matching API + paste-names modal

### Admin + Ops
- **FIX.UPLOAD.1-3** — rewire upload button to new CMS API
- **FIX.PIPELINE.1** — opportunities URL ?q= seeding
- **FEEDBACK.EXPORT.1** — feedback export JSON/markdown
- **FB.1** — feedback screenshot upload
- **TIER.BASELINE.1** — manual SERP baseline trigger
- **SERP.CHUNKED** — chunked baseline + weekly with progress UI
- **OG.CATALOG** — OG product catalog tool

### Quality / DMCA / Theme
- **DMCA.TAGGING** — restriction_type column (DMCA / Trademark / RegionLock / TOS) + admin picker + dashboard badge + filter
- **THEME.BRAND** — brand-aware theming (Option C)
- **RANKINGS.UX** — bucket filter + chart hover tooltip
- **JWT.COUNTDOWN** — live JWT countdown timer
- **UPLOAD.FEEDBACK** — visible upload result on /content/products
- **UPLOAD.JWT.INLINE** — inline JWT refresh
- **COWORK.PREVIEW** — read-only Cowork queue section (parallel-chat coordination)
- **PPT.MEETING** — boss meeting deck generator

---

## Key architectural decisions

1. **Per-tier AI model selection** — Opus only for T1 strategic, Sonnet for T2/T0, Haiku for translation. ~74% cost cut. Env-tunable.

2. **Per-market tier separation** (Sprint TIER.PER.MARKET) — same product can have separate tier rows for US and ID; bestsellers diverge by market.

3. **Keyword language → market mapping** (Sprint MARKETS.PRUNE) — EN keywords run against US only, ID keywords against ID only. Implicit alignment via tier_keywords.language.

4. **DMCA per-product, not per-market** (Galih's call) — restriction_type stored per row but auto-synced across market rows for same relation_id.

5. **GSC alerts split by tier** — T1 day-over-day (10% threshold), T2/others WoW (15% with 4-day freshness lag).

6. **Mimir scoped by site + market** — memories don't leak between brands or markets.

7. **A/B framework runs ON the AI itself** — ID-native vs EN-translate is deterministic 50/50 per brief, locked once assigned.

8. **Brand-aware theming + Slack routing** — multi-tenant from the ground up.

9. **Friday KPI as combined channel** — G2G + OG in one Slack channel by Galih's preference (team reads them together).

10. **Cowork integration intentionally minimal** — see HANDOFF_COWORK_INTEGRATION.md. The parallel chat owns sections 3-5 of the handoff.

---

## Migration list (chronological, all applied unless noted)

Run order for fresh deploy:
1. add_pipeline_assignee_tracking.sql
2. add_product_tiers (category, restriction_type, market — in order)
3. add_tier_ranking_tracker.sql (tier_keywords + tier_serp_snapshots)
4. add_language_to_tier_keywords.sql
5. add_market_to_product_tiers.sql
6. add_g2g_products canonical
7. mimir_memories + add_market_to_mimir_memories.sql
8. seo_content_briefs + add_id_experiment_variant.sql
9. tyr_autopublish_config
10. brief_review_feedback
11. slack_routing_config
12. news_export_config + add_extracted_keywords_to_news_items
13. cms_tokens
14. serp_baseline_runs (chunked SERP)
15. add_cost_alert_state.sql
16. add_friday_kpi_columns.sql (seo_action_items)
17. add_mimir_onpage_jobs.sql
18. + ~15 more minor patches (last_escalated_at, output_type, etc.)

---

## Live state (as of 2026-05-16)

- 1.58M monthly organic clicks (GSC)
- 12.6M monthly impressions, 12.6% CTR, avg position 7.6
- 1.4M AI citations on Bing since Dec
- 3.6K AI mentions on Semrush, citations +23.9% MoM, cited pages +11.5% MoM
- Daily organic clicks 3x where they were 3 years ago
- 0 new hires
- Authority Score 54, 56.4K backlinks, 177K organic keywords ranking

**Active expansion plan**: new markets next quarter (TH and/or VN tentative).
