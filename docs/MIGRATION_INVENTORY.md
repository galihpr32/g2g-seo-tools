# Coolify Migration Inventory

**Generated**: 2026-05-28
**Scope**: Migrating from Vercel + Supabase Cloud + GitHub Actions → Coolify (self-hosted Docker PaaS) + self-hosted Supabase on Coolify
**Target server**: Branding Server (Coolify v4.0.0, Ubuntu 24.04 aarch64, AWS)
**Migration plan**: see end of this file for phased approach

---

## 1. ENVIRONMENT VARIABLES

### Supabase (3 vars — all REQUIRED)
| Var | Type | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Change to self-hosted Supabase URL on Coolify |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Regenerated from self-hosted instance |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Regenerated from self-hosted instance |

### Google Cloud (4 critical + several optional)
| Var | Type | Required | Notes |
|---|---|---|---|
| `GOOGLE_CLIENT_ID` | secret | yes | Same value, add new redirect URI in Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | secret | yes | Same |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | secret | yes | Same |
| `GOOGLE_PRIVATE_KEY` | secret | yes | Same |
| `GOOGLE_DRIVE_FOLDER_ID` | secret | optional | Same |
| `GA4_PROPERTY_ID` | secret | optional | Per-site default; site_configs.ga4_property_id overrides |
| `CRUX_API_KEY` | secret | optional | CrUX integration |
| `PSI_API_KEY` | secret | required for PSI cron | PageSpeed Insights |

### Anthropic (1 required + 6 optional flags)
| Var | Type | Required | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret | yes | Same |
| `ANTHROPIC_MONTHLY_BUDGET_USD` | secret | optional | Cost cap |
| `BRAGI_MODEL_T*` (T0/T1/T2/TRANSLATION) | secret | optional | Per-tier model overrides |
| `ID_NATIVE_MODEL` | secret | optional | ID experiment |
| `TYR_MODEL` | secret | optional | Tyr translator |
| `MIMIR_ONPAGE_MODEL` | secret | optional | Mimir learner |

### DataForSEO
| Var | Type | Required |
|---|---|---|
| `DATAFORSEO_LOGIN` | secret | yes |
| `DATAFORSEO_PASSWORD` | secret | yes |
| `DATAFORSEO_ACTIVE_MARKETS` | secret | optional |

### Slack (6 vars)
| Var | Type | Required |
|---|---|---|
| `SLACK_WEBHOOK_URL` | secret | recommended |
| `SLACK_BOT_TOKEN` | secret | yes (for PNG uploads) |
| `SLACK_CHANNEL_ID` | secret | yes |
| `SLACK_SIGNING_SECRET` | secret | yes (for interactive payloads) |
| `NEXT_PUBLIC_TEST_SLACK_*` (×3: WEBHOOK / CHANNEL_ID / CHANNEL_LBL) | public | optional, prefill helper |

### Other Third-Party
| Var | Type | Required |
|---|---|---|
| `FIRECRAWL_API_KEY` | secret | optional |
| `SEMRUSH_API_KEY` | secret | optional |
| `OPENAI_API_KEY` | secret | optional (fallback) |
| `CREW_VUE_API_KEY` + `CREW_VUE_AUTH_TYPE` | secret | optional |
| `BING_WEBMASTER_API_KEY` + `BING_SITE_URL` | secret | optional |

### App + Cron Config
| Var | Type | Required | Action for Coolify |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | public | yes | **Change** to `https://g2g-seo-tools.dynamicpodium.com` (or chosen domain) |
| `APP_URL` | secret | optional | Same |
| `CRON_SECRET` | secret | yes | Same value, also set in Coolify Scheduled Tasks |
| `NEXTAUTH_SECRET` | secret | optional | Same |
| `NEXTAUTH_URL` | secret | optional | Same |

### Vercel-specific (DROP these)
| Var | Notes |
|---|---|
| `VERCEL` | Auto-set by Vercel; remove |
| `VERCEL_URL` | Auto-set by Vercel; remove |
| `CHROMIUM_PACK_URL` | Sparticuz custom URL — no longer needed (system chromium) |
| `PUPPETEER_EXECUTABLE_PATH` | Will be set to `/usr/bin/chromium` in Dockerfile |

### Misc Config Constants
- `COST_ALERT_WARNING_USD`, `COST_ALERT_CRITICAL_USD`
- `GSC_LAG_DAYS`, `GSC_OTHERS_WOW_THRESHOLD`, `GSC_T`
- `FORSETI_INGEST_TOKEN`, `FORSETI_USER_AGENT`
- `FEEDBACK_ADMINS`, `ID_EXPERIMENT_FORCE`, `OG_OWNER_USER_ID`
- Feature flags: `SKILL_SCHEMA_GEN_ENABLED`, `SKILL_INTLINK_AUDIT_ENABLED`, `SKILL_BROKENLINK_AUDIT_ENABLED`, `SKILL_AI_VIS_RECOMMENDATIONS_ENABLED`

**Total env vars to migrate**: ~45 required + ~25 optional.

---

## 2. CRON JOBS

### vercel.json (2 entries)
Bisa di-archive setelah migration:
- `/api/cron/gsc-daily` — `0 1 * * *` (daily 01:00 UTC)
- `/api/cron/game-trends-refresh` — `0 3 * * *` (daily 03:00 UTC)

### GitHub Actions Workflows (38 total)
**These are the actual cron drivers — vercel.json crons are redundant duplicates.**

Authentication pattern: every workflow does `curl -H "Authorization: Bearer $CRON_SECRET" $APP_URL/api/cron/<name>`. So after migration, just update **`APP_URL` GitHub repo secret** to point to new Coolify domain. All 38 workflows keep working unchanged.

**Hourly / Every-N-min**:
- `agents-scheduler` — every 30 min
- `process-briefs` — every 10 min
- `product-content-auto` — every 5 min
- `forseti-scraper` — every hour at :05

**Daily**:
- `gsc-daily` (01:00 UTC), `bing-daily` (23:30), `daily-briefing` (00:00 weekdays), `cost-alert` (06:00), `game-trends-refresh` (03:00), `backlinks-verify` (03:00), `tier-rank-alerts` (02:00), `brief-outcomes-snapshot` (02:00), `brief-outcomes-classify` (02:30), `opportunities-snooze` (02:00), `outreach-followup` (06:00), `keyword-rankings` (04:00), `hugin-aggregate` (04:30), `bifrost-newsjacking` (05:30)

**Weekly (Mondays)**:
- `weekly-report-generator` (01:00), `weekly-report-publish` (08:00), `tier-weekly-summary` (03:00), `cannib-snapshot` (03:00), `agent-performance-weekly` (02:00), `learning-aggregator-weekly` (04:00), `mimir-tune` (02:00), `experiment-metric-update` (06:00), `news-export-weekly` (01:00), `tech-escalation` (02:00)
- Sundays: `frey-weekly` (18:00), `schema-health` (04:00)
- Every 6 hours: `bifrost` (`15 */6 * * *`)

**Monthly**:
- `monthly-report-generator` (4th, 01:00 UTC)
- `psi-monthly` (1st, 05:00)
- `saga-clusters` (1st, 04:00)
- `kb-rule-extraction` (5th, 02:00)

**Paused (no auto-fire)**:
- `friday-kpi` — paused per Galih request 2026-05-22; manual trigger only
- `tier-serp-weekly` — paused 2026-05-14

### cron-jobs.org
**None found**. All scheduled work is via GitHub Actions + vercel.json (which we'll abandon).

### Migration approach for crons
**Option A (recommended)**: Keep GitHub Actions as-is. Just update `APP_URL` GitHub secret to `https://g2g-seo-tools.dynamicpodium.com`. Zero workflow changes.

**Option B**: Move to Coolify Scheduled Tasks. More moving parts but removes external dependency.

→ Go with **Option A** for speed. Revisit later if needed.

---

## 3. VERCEL-SPECIFIC CODE

### Puppeteer + Chromium (NEEDS REFACTOR)
- `src/app/api/reports/friday-kpi/render-png/route.ts` → calls `htmlToPng()` from `src/lib/reports/puppeteer-launcher.ts`
- Currently uses `@sparticuz/chromium` (Lambda-optimized binary download)
- `next.config.ts` lists both `puppeteer-core` + `@sparticuz/chromium` in `serverExternalPackages`

**Action**: refactor `puppeteer-launcher.ts` to detect environment:
- If `PUPPETEER_EXECUTABLE_PATH` set (Coolify Docker) → launch with that path
- Else fallback to `@sparticuz/chromium` (Vercel)

This is **the only major code change** required. Dockerfile installs `chromium` via apt.

### maxDuration exports (NO ACTION REQUIRED)
126+ API routes export `maxDuration` (values 5-300s). These were Vercel Pro features. On self-hosted Coolify/Node, `maxDuration` export is ignored at runtime — actual timeout is controlled by reverse proxy (Traefik). Coolify default is unlimited, can set per-app override. The code keeps working unchanged.

### runtime = 'edge'
**None found**. All routes are `nodejs` runtime. ✓

### x-vercel-cron header check
**None found**. All cron routes use `Authorization: Bearer ${CRON_SECRET}` — fully portable. ✓

### Vercel Edge primitives (geolocation, KV, Blob, Postgres, Analytics)
**None used**. All third-party state in Supabase. ✓

### `after()` from `next/server`
4 usages — all work fine on self-hosted Next.js:
- `/api/opportunities/[id]/queue-brief/route.ts`
- `/api/mimir/chat/route.ts`
- `/api/mimir/onpage/learn/route.ts`
- `/api/pipeline-journey/approve/route.ts`

These run after response is sent; Next.js runtime handles them on any host.

### vercel.json
2 cron entries (already replaced by GitHub Actions workflows). After migration: **archive** the file (rename `.archive`), don't delete (rollback safety).

---

## 4. EXTERNAL API CALLBACKS / REDIRECT URIs

### Google OAuth (CRITICAL — must update after domain switch)
- Endpoint: `/api/auth/google/callback`
- Constructed URL: `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback`
- Registered in: **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs**
- Action: ADD new domain `https://g2g-seo-tools.dynamicpodium.com/api/auth/google/callback` to "Authorized redirect URIs". Keep old Vercel URL during overlap period for rollback safety.

### Slack
- `/api/slack/interactive` — Slack interactive payload endpoint
- Configured in Slack App settings → Interactivity & Shortcuts → Request URL
- Action: update request URL to new domain after cutover.

### No other webhooks found
- DataForSEO: no callback (synchronous API)
- Anthropic: API key only, no webhook
- Bing Webmaster: API key, no webhook
- Slack outbound: webhook URLs are outbound (we POST to them) — no inbound URL needed

---

## 5. DATABASE

- Total migrations: **137 `.sql` files** in `supabase/migrations/`
- Database size (per Supabase Cloud dashboard 2026-05-28): **0.331 GB** (small, dump < 1 minute)
- Uses Supabase `auth` schema for user accounts (3 MAU)
- No Supabase Storage usage (0 GB)
- No Supabase Edge Functions (0 invocations)
- Minimal Realtime usage (1 connection, 9 messages — borderline unused)

**Migration plan**: `pg_dump` from Supabase Cloud (schemas: `public`, `auth`, `storage`) → restore to self-hosted Supabase on Coolify. All RLS policies + auth.users transfer intact.

---

## 6. DOCKERFILE / BUILD CONFIG STATUS

### Current state
- **NO Dockerfile** in project root
- `next.config.ts`:
  ```ts
  serverExternalPackages: ['puppeteer-core', '@sparticuz/chromium']
  ```
- `package.json` scripts: `dev`, `build`, `start`, `lint` (standard Next.js)
- Next.js version: `16.2.4`
- Node version: not pinned (no `.nvmrc` or `engines` field) — Coolify will default to LTS

### What needs to be added
1. **`Dockerfile`** at root — multi-stage build, native chromium install
2. **`.dockerignore`** at root
3. **Update `next.config.ts`** to add `output: 'standalone'` (slimmer Docker image)
4. **Update `src/lib/reports/puppeteer-launcher.ts`** to detect Docker env via `PUPPETEER_EXECUTABLE_PATH`
5. **Optional: `.nvmrc`** pinning Node 20 LTS for reproducibility

---

## 7. NOTABLE FILES TO REVIEW

**Critical for migration**:
1. `src/middleware.ts` — Supabase client init, runs every request
2. `src/lib/supabase/{client,server,service}.ts` — Supabase client wiring
3. `src/lib/reports/puppeteer-launcher.ts` — must refactor for native chromium
4. `src/app/api/reports/friday-kpi/render-png/route.ts` — Chromium-dependent endpoint
5. `src/app/api/auth/google/callback/route.ts` — OAuth redirect URI handling
6. `.github/workflows/*.yml` — 38 files; will continue working after APP_URL secret update
7. `vercel.json` — archive after migration

---

## MIGRATION PLAN (Phased)

### ✅ Phase 0 — Inventory & docs (DONE)
This file. Audit complete.

### ⏳ Phase 1 — Coolify setup (manual via dashboard)
- **DevOps prereqs**:
  - Confirm server total RAM ≥ 4 GB (current shows 0.4 GB — likely under-spec)
  - Confirm DNS `*.dynamicpodium.com` wildcard exists, OR request specific A-record for `g2g-seo-tools.dynamicpodium.com`
- In Coolify dashboard (Branding-Team → Branding Server):
  1. New Project: "g2g-seo-tools"
  2. New Resource → Database/Service template: **Supabase** (one-click stack)
  3. Wait for containers up; copy generated `SUPABASE_URL`, `ANON_KEY`, `SERVICE_KEY`, Postgres connection string
  4. Save to Coolify Project shared variables

### ⏳ Phase 2 — Database migration
1. Backup from Supabase Cloud:
   ```bash
   pg_dump "postgres://postgres.[REF]:[PWD]@aws-0-[region].pooler.supabase.com:6543/postgres" \
     --schema=public --schema=auth --schema=storage \
     --no-owner --no-acl --no-publications --no-subscriptions \
     -f g2g-seo-tools-dump.sql
   ```
2. Restore to Coolify Postgres:
   ```bash
   psql "postgres://postgres:[NEW_PWD]@[COOLIFY_DB_HOST]:5432/postgres" < g2g-seo-tools-dump.sql
   ```
3. Verify row counts table-by-table.

### ⏳ Phase 3 — Code changes for Coolify (preserve Vercel compat)
- Add `Dockerfile` (multi-stage, chromium via apt)
- Add `.dockerignore`
- Update `next.config.ts` (add `output: 'standalone'`)
- Refactor `puppeteer-launcher.ts` (detect `PUPPETEER_EXECUTABLE_PATH`)
- Test build locally with `docker build`

### ⏳ Phase 4 — Deploy app to Coolify
- New Resource → Application → Source: Git
- Build pack: Dockerfile
- Port: 3000
- Set all env vars from Section 1
- Trigger first deploy
- Smoke test endpoints

### ⏳ Phase 5 — OAuth + DNS update
- Add new domain redirect URI in Google Cloud Console
- Set `NEXT_PUBLIC_APP_URL` env var in Coolify
- Update Slack App interactive URL
- Update `APP_URL` GitHub repo secret → cron workflows now point to Coolify

### ⏳ Phase 6 — Validate + cutover
- Verify Friday KPI Slack send works
- Verify Public PNG accessible
- Verify all 38 cron workflows fire successfully (monitor 1-3 days)

### ⏳ Phase 7 — Decommission (after 1 week stable)
- Pause Vercel project (don't delete)
- Pause Supabase Cloud project
- Delete after 2 weeks of stable Coolify operation

---

## OPEN QUESTIONS (BLOCKING)

1. **Server RAM** — current shows 0.4 GB; need DevOps to confirm ≥ 4 GB available
2. **DNS** — wildcard `*.dynamicpodium.com` exists? If not, DevOps must add A-record
3. **Cron approach** — Option A (keep GitHub Actions, update APP_URL) confirmed?

Once these are answered, Phase 1 can start.
