# Session Progress — 2026-05-07

Continuation of yesterday's session
([SESSION_PROGRESS_2026-05-06.md](./SESSION_PROGRESS_2026-05-06.md)).
Today focused on Phase 3 multi-brand isolation + diagnostic fixes +
PPTX builder polish + manual OG report generation.

---

## TL;DR — what shipped today

1. **Phase 3 multi-brand isolation** — closed every gap identified in the
   prior handoff. 13 routes + 2 helper modules + 1 client hook + 4
   migrations. G2G + OG now fully isolated end-to-end.
2. **OG monthly report** — built manually with G2G PPTX builder, then
   re-built with custom blue-themed accent. Surfaced + fixed a latent
   `backlinks` field-name bug in the builder while we were there.
3. **Pipeline Journey UI** — limit selector dropdown (60/100/200/500/All)
   + "Include dismissed" toggle. API cap raised 200 → 1000.
4. **System Health diagnostics** — pinpointed Slack env-var issue
   (`SLACK_CHANNEL_ID` missing at runtime), agent-runs filter root cause,
   GSC token expired flow.

---

## Files changed today (all uncommitted)

### Migrations (NEW — all need to run in Supabase)

| File | Purpose |
|---|---|
| `supabase/migrations/add_outreach_domain_scores.sql` | Hermod v2 cache table (from yesterday) |
| `supabase/migrations/add_monthly_report_pptx_columns.sql` | Optional — PPTX export now uses direct download |
| `supabase/migrations/add_site_slug_to_agent_tables.sql` | `site_slug` on `agent_runs` + `agent_actions` (Task #23) |
| `supabase/migrations/add_site_slug_to_knowledge_base.sql` | `site_slug` on `knowledge_base_items` + `*` slug for shared brand rows (Task #26) |
| `supabase/migrations/add_site_slug_to_paid_backlinks.sql` | `site_slug` on `paid_backlinks` + auto-backfill for OG URLs |
| (yours from yesterday) `add_offgamers_phase1.sql` | ✅ **Already run** |
| (yours from yesterday) `add_offgamers_phase1_constraints.sql` | ✅ **Already run** |

### Code — multi-brand isolation

| File | What changed |
|---|---|
| `src/lib/sites.ts` | **NEW exports** — `resolveSiteSlugFromRequest(req, body?)` server helper + extended types |
| `src/lib/hooks/useSiteSlug.ts` | **NEW** — React hook reads URL prefix → cookie → localStorage → 'g2g' |
| `src/app/(dashboard)/command-center/pipeline/page.tsx` | Wired `useSiteSlug()` (replaced hardcoded `site=g2g`) + added limit dropdown + dismissed toggle |
| `src/app/api/backlinks/audit/route.ts` | site-aware via helper |
| `src/app/api/reports/weekly/route.ts` | site-aware via helper (GET + POST) |
| `src/app/api/opportunities/route.ts` | site-aware via helper |
| `src/app/api/serp-features/route.ts` | site-aware via helper |
| `src/app/api/agents/actions/route.ts` | site-aware via helper |
| `src/app/api/agents/[key]/run/route.ts` | site-aware via helper |
| `src/app/api/pipeline-journey/route.ts` | site-aware + limit max 1000 + `includeDismissed` param |
| `src/app/api/agents/aggregate/route.ts` | site-aware via helper |
| `src/app/api/ai/confirm-agent-run/route.ts` | Forwards active site to agent run (was hardcoded `'g2g'`) |
| `src/app/api/agents/findings/route.ts` | site-scoped agent_findings query |
| `src/app/api/agents/needs-attention/route.ts` | site-scoped agent_runs query |
| `src/app/api/agents/insights/route.ts` | site-scoped agent_actions + briefs + keyword_maps queries |
| `src/app/api/agents/performance/route.ts` | site-scoped agent_runs + agent_actions |
| `src/app/api/agents/status/route.ts` | site-scoped pending agent_actions |
| `src/app/api/system/health/route.ts` | site-scoped queries + **specific Slack missing var labels** |
| `src/app/api/actions/route.ts` | Uses helper for site resolution (replaces hand-rolled cookie regex) |
| `src/app/api/actions/export/route.ts` | site-scoped action items + per-brand site_url via site_configs |
| `src/app/api/tools/url-analysis/route.ts` | brand-aware `isOwnPage` check + site-scoped action lookup |
| `src/app/api/brief-outcomes/route.ts` | Filter via `seo_content_briefs!inner.site_slug` join |
| `src/app/api/dmca/scan/route.ts` | site-scoped published briefs |
| `src/app/api/cron/agents-scheduler/route.ts` | Iterates (agent × site) — was hardcoded `'g2g'` |
| `src/app/api/cron/weekly-report-generator/route.ts` | Iterates (owner × site) pairs |
| `src/app/api/cron/monthly-report-generator/route.ts` | Iterates (owner × site) pairs |
| `src/app/api/knowledge-base/route.ts` | site-scoped GET (active + `*` shared) + POST accepts `site_slug='*'` |
| `src/lib/agents/brief-generator.ts` | New `loadBrandName(db, siteSlug)` helper. `BriefInput.siteSlug` field. `loadKBBlock` accepts siteSlug. 3 callsites threaded. Prompt-level "G2G" → `${brandName}` interpolation in main + assembly + outreach prompts. Tool descriptions made brand-neutral. |

### Code — OG monthly report data leaks

| File | What changed |
|---|---|
| `src/lib/reports/agent-insights.ts` | `getAgentInsights()` accepts `siteSlug` param, filters agent_runs/agent_actions/briefs by site |
| `src/app/api/reports/monthly/route.ts` | Passes siteSlug to getAgentInsights + paid_backlinks filter |
| `src/app/api/reports/weekly/route.ts` | Passes siteSlug to getAgentInsights |

### Code — PPTX builder polish

| File | What changed |
|---|---|
| `src/lib/reports/pptx-builder.ts` | **NEW theme system** — `BuildPptxInput.theme.{accent, accent2}` override (default G2G red, OG passes blue). `let T = {...DEFAULT_THEME}` mutable + restored in `finally`. **Backlinks shape fix** — accepts both `activeCount/newThisMonthCount` (legacy) and `totalActive/newThisMonth` (DB shape) via `??` fallback. Latent bug — backlinks slide was silently skipped on every G2G PPTX export. |

---

## ⚠️ ACTION ITEMS FOR PUSH (PR checklist)

### 1. Migrations to run in Supabase (in order)

```sql
-- A. Hermod v2 (from yesterday — possibly already run)
\i supabase/migrations/add_outreach_domain_scores.sql

-- B. Optional, low priority — PPTX is direct download now
\i supabase/migrations/add_monthly_report_pptx_columns.sql

-- C. Site_slug on agent runs + actions (Task #23) — REQUIRED
\i supabase/migrations/add_site_slug_to_agent_tables.sql

-- D. Site_slug on knowledge base (Task #26)
\i supabase/migrations/add_site_slug_to_knowledge_base.sql

-- E. Site_slug on paid_backlinks (OG monthly leak fix)
\i supabase/migrations/add_site_slug_to_paid_backlinks.sql
```

After each, verify with the corresponding SELECT (see verification SQL at the end).

### 2. Vercel env vars

- [ ] `SLACK_CHANNEL_ID` — confirm runtime sees it (Health was missing it).
      Common cause: env var marked Sensitive needed redeploy after edit.
      System Health (after this session's patch) prints exactly which var
      is missing — refresh `/command-center/health` to verify.
- [ ] `GOOGLE_PRIVATE_KEY` — already paste-cleaned (`getAuth()` handles
      stray quotes + `\n` escapes)
- [ ] `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD` — required for Hermod v2
      + OG SoV
- [ ] `FIRECRAWL_API_KEY` — required for Hermod v2 evaluator
- [ ] `ANTHROPIC_API_KEY`, `CRON_SECRET` — assumed already set

### 3. UX setup (not code)

- [ ] **Save agent schedules.** `/command-center/settings` → toggle each
      agent ON, set freq + day + time + timezone, click **Save** per
      agent. Cron only fires when `schedule_enabled = true` is persisted
      to DB. Toggle visual ON ≠ DB true until Save is clicked.
- [ ] **Reconnect GSC** if token still expired
- [ ] **Share OG Drive folder with service account email** (for any
      future Drive ops — PPTX export goes direct download now)

### 4. Test artifacts to delete from repo root

```bash
rm test-pptx.ts test-pptx.cts build-real.ts build-cards.ts build-cards.ts.bak build-og.ts
# Optional — keep if you want manual fallback:
# rm G2G-Monthly-Report-April-2026.pptx OffGamers-Monthly-Report-April-2026.pptx
```

### 5. Push order

```bash
sudo rm -f .git/index.lock 2>/dev/null
git add -A
git commit -m "feat: Phase 3 multi-brand isolation + PPTX brand themes + Pipeline Journey UI controls"
git push
```

---

## Verification SQL (run after migrations)

```sql
-- A. Confirm site_slug on agent tables
SELECT column_name FROM information_schema.columns
WHERE table_name IN ('agent_runs','agent_actions') AND column_name = 'site_slug';
-- expect 2 rows

-- B. Confirm site_slug on knowledge_base_items
SELECT column_name FROM information_schema.columns
WHERE table_name = 'knowledge_base_items' AND column_name = 'site_slug';
-- expect 1 row

-- C. Confirm site_slug on paid_backlinks + OG backfill
SELECT site_slug, COUNT(*) FROM paid_backlinks GROUP BY site_slug;
-- should show g2g | N (and offgamers | M after OG starts adding links)

-- D. Sanity — opportunities by status (Pipeline Journey)
SELECT status, COUNT(*) FROM seo_opportunities
WHERE site_slug = 'g2g' GROUP BY status ORDER BY count DESC;

-- E. Recent agent runs (after schedules saved)
SELECT agent_key, site_slug, status, started_at FROM agent_runs
WHERE started_at > NOW() - INTERVAL '24 hours'
ORDER BY started_at DESC LIMIT 20;
```

---

## Open issues / not done yet

### 🔴 Pipeline Journey stuck briefs (from §13 of HANDOFF.md)

6 opportunities stuck at `brief_queued` since 2026-04-29. Still
**unresolved** — needs Opus debugging session. Symptoms:
- `opp.status = 'brief_queued'`, `opp.brief_id = <uuid>`,
  `brief.status = 'draft'` (or 'generating')
- Multiple Sonnet fix attempts didn't resolve
- Manual "⚡ Process stuck" button + cron `/api/cron/process-briefs`
  exist but aren't reliably triggering Bragi

Diagnosis hypotheses to test:
1. Vercel Hobby `maxDuration` budget hit by `generateAgentBrief` (>60s
   per brief)
2. `after()` from `next/server` silently dropping background work on
   Hobby plan
3. Brief query filter excluding valid candidates

Run this in Supabase first:
```sql
SELECT o.id, o.status, o.brief_id, b.status AS brief_status,
       b.notes IS NOT NULL AS has_notes,
       b.notes LIKE '%Queued from Opportunity%' AS has_tag
FROM seo_opportunities o
LEFT JOIN seo_content_briefs b ON b.id = o.brief_id
WHERE o.status = 'brief_queued';
```

### 🟡 Slack notifications not firing

After SLACK_CHANNEL_ID gets fixed, verify by:
1. Run Heimdall manually from Command Center
2. Wait for completion
3. Check #writer-rangers (or whatever channel ID points to)

If still nothing arrives:
- Bot not invited to channel — `/invite @G2G-SEO-Bot`
- Token has wrong scopes — needs `chat:write` minimum

### 🟡 SEMrush 403 / quota

Same issue from yesterday. Hermod v2 already replaced SEMrush for
outreach. But keyword tracking + competitor benchmarks (used in monthly
report) still hit SEMrush. Either:
- Upgrade SEMrush plan
- OR build DataForSEO-based replacement for the keyword overview path

---

## File-system cleanup (manual, post-push)

These got created during sandbox testing and the Linux container can't
unlink them across the macOS bind mount:

```
test-pptx.ts
test-pptx.cts
build-real.ts
build-cards.ts
build-cards.ts.bak
build-og.ts
G2G-Monthly-Report-April-2026.pptx       (delete or keep)
OffGamers-Monthly-Report-April-2026.pptx (delete or keep)
```

`rm` from your Mac terminal in the repo root.

---

## Tasks completed this session

| # | Task | Status |
|---|---|---|
| Hermod v2 closeout | from yesterday | ✅ |
| Monthly Report PPTX | from yesterday | ✅ |
| Task #28 — OG site_configs row | verify-only (already seeded) | ✅ |
| Task helpers — `resolveSiteSlugFromRequest` + `useSiteSlug` | ✅ |
| Task #20 — 9 routes site-aware | ✅ |
| Task #19 — pipeline page hook integration | ✅ |
| Task #23 — agent data isolation (6 routes) | ✅ |
| Task #24 — action items + brief outcomes | ✅ |
| Task #25 — cron jobs iterate sites | ✅ |
| Task #26 — KB per-site | ✅ |
| Task #27 — Bragi prompt branding | ✅ |
| OG monthly report leaks (paid_backlinks + agent_insights) | ✅ |
| OG PPTX manual build (red → blue theme) | ✅ |
| Latent backlinks shape bug | ✅ |
| Pipeline Journey UI (limit dropdown + dismissed toggle) | ✅ |
| Slack diagnostic — specific var name | ✅ |

---

_End of checkpoint. If context lost: read this file + the
`SESSION_PROGRESS_2026-05-06.md` checkpoint + `HANDOFF.md` to
reconstruct decision history._
