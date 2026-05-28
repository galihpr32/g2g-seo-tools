# Session Progress — 2026-05-06

Comprehensive log of everything built/fixed in the recent multi-day Cowork
session. Saved as a checkpoint in case context is lost — read this first
when resuming.

---

## TL;DR — What's done, what's pending

**Done in code (uncommitted at time of writing):**
- Hermod v2 (DataForSEO + FireCrawl + Haiku evaluator replacing SEMrush)
- Google Sheets / Drive `getAuth()` defensive hardening
- (Earlier in session) GSC date fixes, monthly report accuracy, Pipeline
  Execute logic, Product Content CSV import/export with dedup, Bifrost news
  agent, SERP recommend → Bragi, SERP tracking history, Bragi lead paragraph
  enforcement, Internal Links polling extension.

**Pending action items (you/Galih):**
1. `sudo rm` the stuck `.git/index.lock` and commit + push (see "Saving" below).
2. Run new Supabase migrations (list below).
3. Re-paste `GOOGLE_PRIVATE_KEY` in Vercel (regenerated from Google Cloud
   Console → IAM → Service Accounts → Keys → Add key → JSON; copy
   `private_key` field as-is, NO surrounding quotes).
4. Set `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` if not already there
   (Hermod v2 needs them).
5. Decide: G2G + OG multi-brand (recommended) vs. duplicate the codebase.

---

## Hermod v2 — outreach without SEMrush

### Why
SEMrush API hit 403 / quota exhausted. Replaced with stuff already paid for:
DataForSEO (SERP) + FireCrawl (scrape, 7d cache) + Claude Haiku (evaluator).

### Files

| File | Purpose |
|---|---|
| `supabase/migrations/add_outreach_domain_scores.sql` | New table `outreach_domain_scores` (5 sub-scores 0-10, overall, angle, has_write_for_us, contact_email, scraped_urls[], 14d TTL) + adds `approval_required` / `approved_for_send_at` / `approved_for_send_by` to `outreach_prospects` |
| `src/lib/agents/hermod-domain-eval.ts` | Domain evaluator: skip-list filter → cache check → FireCrawl scrape (homepage + /about + /write-for-us probe) → Haiku tool_use 5-dim scoring → upsert with 14d TTL. Email regex with no-reply filter. Three thresholds: strict (≥7.5), balanced (≥6.5), loose (≥5.5). |
| `src/app/api/outreach/discover/route.ts` | Rewritten: DataForSEO SERP top 10 → auto-skip filter → parallel evaluator → threshold filter |
| `src/app/(dashboard)/outreach/page.tsx` | DiscoveryPanel rewritten with score column (color-coded 0-10), outreach angle, signals (✍️/📧), region selector (US/UK/AU/SG/ID), threshold dropdown, Brief mode toggle |
| `src/app/api/outreach/prospects/route.ts` | POST accepts `approval_required` + `score_breakdown`. Brief-mode rows insert with `approved_for_send_at = null` |

### Score weighting
```
overall = niche*0.30 + quality*0.25 + outreach*0.25 + audience*0.10 + trust*0.10
```

### Skip-list (auto-dropped before eval)
Reddit, YouTube, TikTok, Twitter/X, Discord, Facebook, Instagram, Pinterest,
LinkedIn, Threads, Tumblr, Snapchat, Quora, StackExchange, Stack Overflow,
Amazon, eBay, Medium, Wikipedia, Fandom, Google, Bing, Yahoo, DuckDuckGo,
Twitch, Vimeo, App Store, Play Store.

### Brief mode
When the user toggles "Brief mode" on the Outreach Discovery page, prospects
are queued with `approval_required=true` and `approved_for_send_at=null`.
They sit idle until the user clicks Send on the tracker. Default behaviour
(auto-active) still works for non-brief-mode adds.

### User-confirmed design choices
1. Threshold default: `balanced` (≥6.5)
2. Auto-skip social media: yes
3. Replace SEMrush entirely (not parallel)
4. Re-evaluate every 14 days (TTL on `outreach_domain_scores`)
5. Brief mode: yes — queue then user clicks Send

---

## Earlier work in this session (already committed in past pushes,
reference for context)

### Reports accuracy fix
- **Bug:** April monthly report showed 247K clicks vs GSC 1.63M.
- **Fix:** Always call live GSC API with `rowLimit: 5000`. Snapshots used
  only as fallback. Same fix applied to monthly + weekly routes.

### GSC date format
- **Bug:** GSC API rejected `'90daysAgo'` ("not a valid date string").
- **Fix:** Convert to YYYY-MM-DD in 3 routes (cannibalization, broken-urls,
  one other). GA4-style strings only work for GA4, not GSC.

### Pipeline Execute stuck "Waiting for approved brief"
- **Bug:** Stage Brief logic checked `isClaudeReviewing` before
  `isPublished`. After user clicks Mark Published, briefs with
  `claude_review_status='pending'` got stuck.
- **Fix:** Reorder priority in `/api/pipeline-journey/route.ts` — `isPublished`
  wins. Mark Published also auto-sets `claude_review_status='skipped'`.

### Content ROI dual-source GA4 + UNION
- GA4 lookup now reads from env first, falls back to `site_configs`.
- Published briefs UNION'd with `keyword_map_clusters` so both surfaces
  appear in the ROI view. New `source: 'keyword_map' | 'pipeline_brief'`
  field.

### Internal Links polling extension
- Polling extended from 60s × 1min to 60s × 10min (60 attempts, 10s each).
- Added `auditProgress` state with live "Audit running for Xm Ys" text.

### Product Content overhaul (Bug 7)
- **Header-based sheet parser** in `src/lib/google/sheets.ts` —
  `HEADER_PATTERNS` + `resolveColumns()` fuzzy-matches headers, tolerates
  extra columns and reordering. Falls back to legacy positional read if
  no header match.
- **CSV import/export** with strict schema validation:
  - `/api/products/auto-content/csv-export` (mode=template|data)
  - `/api/products/auto-content/csv-import` (preview)
  - `/api/products/auto-content/csv-import/apply` (commit + brand-pattern
    learning)
  - `/api/products/auto-content/imports` (audit history)
- **CSV lib** at `src/lib/csv.ts` — RFC-4180, no deps.
- **Per-row conflict modal** in `/content/products` with dedup by
  `relation_id`. KB learning: brand→category patterns persisted to
  `product_brand_category_patterns`.

### Bifrost news agent
- `src/lib/agents/bifrost.ts` — RSS news ingester + Haiku game extraction.
- `src/lib/news/rss-parser.ts` — zero-dep RSS/Atom parser.
- `supabase/migrations/add_bifrost_news_tables.sql` — tables.
- `.github/workflows/bifrost-news.yml` — every 6 hours.
- UI page: `src/app/(dashboard)/content/news-signals/page.tsx`.

### SERP recommend → Bragi flow
- `supabase/migrations/add_serp_recommend_tables.sql` —
  `firecrawl_url_cache` (7d TTL) + `serp_recommendations` (run history).
- `/api/competitive/serp-recommend` — manual mode, Sonnet, FireCrawl
  enrichment, max 5 ideas/run, per-idea push-to-Bragi.
- HTML output with G2G CMS classes (e.g. `class='text-h4 q-ma-none'`).
- Defensive JSON parsing on the SERP tracker page.

### SERP tracking history
- New "History" tab on SERP Tracker — shows all past runs of tracked
  keywords, not just the latest.

### Bragi lead paragraph enforcement
- After H1, agent must produce a prose paragraph before H2.
- Lead paragraph validator + auto-regenerate-once after Tyr fail.
- Decoupled lambda lifetimes via internal HTTP for assembly.

### Brief outcomes snapshot (Bug 4)
- `supabase/migrations/add_brief_outcomes_snapshot.sql`
- `/api/cron/brief-outcomes-snapshot` — daily +30/+60/+90 GSC capture.
- `.github/workflows/brief-outcomes-snapshot.yml` — daily 02:00 UTC.

### Google Sheets DECODER error fix
- OpenSSL 3.x couldn't decode malformed `GOOGLE_PRIVATE_KEY`.
- Hardened `getAuth()` in both `lib/google/sheets.ts` and
  `lib/google/drive.ts`:
  1. Strip surrounding double-quotes
  2. Convert escaped `\n` → real newlines
  3. Trim whitespace
  4. Fail-fast if BEGIN/END PRIVATE KEY markers missing (helpful error)

---

## Saving (committing the current uncommitted work)

The `.git/index.lock` file got stuck because a `git add -A` from the
Linux container was interrupted. macOS sees the file as owned by a
different UID so GitHub Desktop can't delete it.

Open Terminal:
```
sudo rm "/Users/galih/Documents/Claude/Projects/Individual SEO Tools/g2g-seo-tools/.git/index.lock"
sudo find "/Users/galih/Documents/Claude/Projects/Individual SEO Tools/g2g-seo-tools/.git" -name 'tmp_obj_*' -delete
```

Then in GitHub Desktop, click Commit + Push. All 10 files are already
staged (the `git add` succeeded; the lock blocked only the commit).

---

## Migrations to run in Supabase

In order (most recent first — older ones may already be applied):

1. `supabase/migrations/add_outreach_domain_scores.sql` — Hermod v2
2. `supabase/migrations/add_product_csv_import_tables.sql` — Product CSV
3. `supabase/migrations/add_serp_recommend_tables.sql` — SERP recommend
4. `supabase/migrations/add_bifrost_news_tables.sql` — Bifrost
5. `supabase/migrations/add_brief_outcomes_snapshot.sql` — Bug 4

---

## Vercel env vars to verify

| Var | Used by | Notes |
|---|---|---|
| `GOOGLE_PRIVATE_KEY` | Sheets + Drive | Re-paste from fresh service account JSON, no surrounding quotes |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Sheets + Drive | client_email from the JSON |
| `GOOGLE_DRIVE_FOLDER_ID` | Drive | Optional — folder where generated docs land |
| `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` | Hermod v2, SERP tracker, Loki | Required for Hermod v2 to work |
| `FIRECRAWL_API_KEY` | Hermod v2, SERP recommend | Required |
| `ANTHROPIC_API_KEY` | All Claude agents | Already set |
| `CRON_SECRET` | GitHub Actions crons | Already set |

---

## Open architectural decision: G2G + Offgamers

**Question:** Duplicate the entire tool for OG, or build multi-brand
support so OG accesses the same tool?

**Recommendation:** Multi-brand. Don't duplicate.

### Why duplication is a trap
Every fix this week (cannibalization date, monthly-report 247K vs 1.63M,
Pipeline Execute, Product CSV import, Hermod v2) would have to be made
twice. In 6 months the two repos drift, fixes ship to one and not the
other. Doubles infra cost (Vercel, Supabase, cron quota — already at
the 2-cron Hobby ceiling, duplication forces Pro).

### Why multi-brand is achievable
The tool is already ~80% multi-tenant:
- Almost every table has `owner_user_id` + `workspace_members` RLS
- `getEffectiveOwnerId(supabase, user.id)` already routes to workspace owner
- `site_configs` table + `getSiteUrlForSlug(db, siteSlug)` already exist
- Hermod's signature already takes a `siteSlug` param

### Phased plan
1. **Phase 1 (1-2d)** — `site_configs` row for OG (placeholder values).
   Build site picker in dashboard header. `useSite()` hook.
2. **Phase 2 (3-5d)** — Grep-and-replace hardcoded `'g2g.com'` strings →
   route through `useSite()`. Migrate KB / brand-pattern tables to be
   `site_slug`-scoped.
3. **Phase 2.5 (1d)** — Move per-brand env to `site_configs` rows
   (gsc_property, ga4_property_id, drive_folder_id, product_sheet_id,
   master_pitch_brief_id). Service-account credentials stay shared.
4. **Phase 3 (1d)** — Onboard OG: connect GSC, run first crawls, populate
   brand-category patterns from CSV import.

### Bonus that only multi-brand gives you
- Cross-site reports: "G2G ranks #3, OG ranks #14 for X — port content"
- Shared SERP snapshots → trend tracking covers both
- Shared FireCrawl cache (Hermod evals already shared by URL — second
  brand pitching same domain in same week = free)
- Shared brand-pattern KB (gaming domain knowledge)

### One real cost
Phase 2 grep is grunt work — call it 5–10 days of focused refactor.
But it's additive, not destructive. G2G keeps working the whole time.

---

## Norse agents inventory (for reference)

| Agent | Role | Key files |
|---|---|---|
| Heimdall | Watcher / health | `src/lib/agents/heimdall.ts` |
| Loki | Keyword gap finder | `src/lib/agents/loki.ts` |
| Odin | Strategy / synthesis | `src/lib/agents/odin.ts` |
| Saga | Pipeline + briefing | `src/lib/agents/saga.ts` |
| Bragi | Brief writer / assembler | `src/lib/agents/bragi.ts`, `brief-generator.ts` |
| Tyr | Quality reviewer | `src/lib/agents/tyr.ts` |
| Hermod | Outreach (now v2) | `src/lib/agents/hermod.ts`, `hermod-domain-eval.ts` |
| Vor | Insight surfacing | `src/lib/agents/vor.ts` |
| Bifrost | News listener | `src/lib/agents/bifrost.ts` |
| Frey | (future / placeholder) | — |

---

_Saved at the user's request as a checkpoint. If context is lost, this
file is the source of truth for what's been decided and what's
pending._
