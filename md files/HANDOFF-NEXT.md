# Handoff — Next Session (Sonnet)

**Created:** 2026-05-04
**Author:** Opus session ending — wrapped Saga redesign + Topic Detail Page + Frey F.1 (paused)
**Audience:** Sonnet (or whichever agent picks this up next)
**Scope:** Two specific tasks for next session — deploy Frey F.1 + finish Hermod outreach fix.

---

## ⚠️ Read this BEFORE doing anything

1. **Read `HANDOFF.md`** in this same directory FIRST. It has critical constraints (especially §0.1 Mimir off-limits files), agent system overview, and verification routine.
2. The Mimir baseline md5s in HANDOFF.md were updated 2026-05-04. Run `md5sum src/app/api/ai/chat/route.ts src/components/dashboard/AIAssistant.tsx` BEFORE any edit and again AFTER. They must match the baseline unless your task explicitly says "modify Mimir."
3. Neither task below requires Mimir modification.
4. Run `npx tsc --noEmit` after every batch of edits — the file structure is large (1000+ line page files in some places); type errors are easy to miss.

---

## What was done in the previous session (context only — DON'T re-do)

| Phase | What shipped |
|---|---|
| Bing Webmaster Phase E | Daily sync endpoint `/api/cron/bing-daily`, GH Actions workflow, dedup fix for duplicate row upsert |
| Saga redesign G.1-G.4 | 3-tab nav (Inbox / Clusters / Gaps), drag-tree via dnd-kit, orphan keyword endpoint + UI |
| Topic Detail Page | New `/content/topics/[slug]` route + `/api/topics/[slug]` aggregator endpoint |
| Time-to-content + AI cost metrics | New KPI cards on Topic Detail Page |
| **Frey F.1 (PAUSED — your job to deploy)** | Code complete: migration, OpenAI client, Frey runner, weekly cron endpoint, GH Actions workflow, basic dashboard |

All committed and pushed to `main` already. Verify with `git log --oneline -10`.

---

## Task 1 — Deploy Frey F.1 (~30-45 min)

**Goal:** Activate the Frey AI Visibility Tracker. Code is complete; needs env, migration, and first run.

### Files already in repo (don't recreate)

```
supabase/migrations/add_ai_visibility.sql         # 3 tables + 30 seed prompts
src/lib/llm-clients/openai.ts                     # OpenAI Chat client
src/lib/agents/frey.ts                            # Main agent runner
src/app/api/cron/frey-weekly/route.ts             # Cron endpoint
src/app/api/automation/claude-review/[briefId]/route.ts   # (pre-existing, do not touch)
src/app/api/ai-visibility/route.ts                # Dashboard data API
src/app/(dashboard)/ai-visibility/page.tsx        # Dashboard UI
.github/workflows/frey-weekly.yml                 # GH Actions weekly cron
```

### Step-by-step deploy

**1. Get OpenAI API key (~5 min, user action)**
- Go to https://platform.openai.com → API keys → Create new
- Recommend prepaid mode with ~$10 starter credit
- Copy the `sk-...` value

**2. Add to Vercel env (user action)**
- Vercel dashboard → project `g2g-seo-tools` → Settings → Environment Variables
- Add `OPENAI_API_KEY` = the `sk-...` value
- Mark as Sensitive
- Apply to Production + Preview environments
- Trigger redeploy (Vercel does this automatically on env change)

**3. Run migration in Supabase (user action)**
- Open Supabase SQL editor
- Copy-paste contents of `supabase/migrations/add_ai_visibility.sql`
- Run
- Verify: `SELECT category, COUNT(*) FROM ai_visibility_prompts GROUP BY category;`
- Should return ~30 rows across categories: brand, recommendation, comparison, product, how_to

**4. Smoke test the endpoint (~30 sec)**
```bash
curl -X GET https://g2g-seo-tools.vercel.app/api/cron/frey-weekly \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expected response shape:
```json
{
  "ok": true,
  "runId": "uuid",
  "prompts_queried": 30,
  "llm_calls": 60,                 // 30 prompts × 2 LLMs
  "findings_written": 60,
  "pipeline_actions": <some-number>,
  "alerts_triggered": 0,
  "errors": [],
  "summary": "Frey scan: 30 prompts × 2 LLMs · 60 findings · X pipeline · 0 alerts"
}
```

**5. Verify in dashboard**
- Navigate to https://g2g-seo-tools.vercel.app/ai-visibility
- Should see KPIs (Visibility Score, Mention Rate, Position, Sentiment) populated
- Trend chart shows 1 data point (current week)
- Findings tab shows ~60 rows
- Prompts tab shows 30 prompts grouped by category

**6. (Optional) Manual trigger from GH Actions**
- GitHub repo → Actions tab → "Frey AI Visibility Weekly" workflow → "Run workflow" button
- Confirms the GH Actions cron path works (will run automatically every Sunday 18:00 UTC going forward)

### Cost expectations

- Per Frey run: 60 LLM calls × ~1K tokens output ≈ $0.50-1.50 total ($0.20 OpenAI + $0.30-1.30 Claude)
- Weekly cadence → ~$2-6/month
- Add ~$5-10/month for parser calls (Haiku)
- **Total Frey monthly: ~$7-16/month**

If user reports first run > $5, something's off — check for prompt explosion or runaway loop.

### Failure modes to handle

| Symptom | Cause | Fix |
|---|---|---|
| `OPENAI_API_KEY not configured` | Env var missing or not propagated | Re-check Vercel env, redeploy |
| Empty `ai_visibility_findings` after curl | Owner mismatch — `G2G_OWNER_USER_ID` env points to wrong user | Verify env value matches `auth.users.id` for galih.priambodo@g2g.com |
| `parser_notes: "Parser fallback (Haiku failed: ...)"` repeatedly | Anthropic credit too low | Top up at console.anthropic.com |
| HTTP 401 from Frey endpoint | `CRON_SECRET` mismatch | Re-check Vercel env |
| LLM call timeout | Network or provider outage | Re-run later; the failure is logged in `errors[]` array |

### What NOT to change in Frey deploy

- Don't modify the prompt seed list in `add_ai_visibility.sql` — user will refine after seeing first results
- Don't add Perplexity yet — explicitly deferred to F.2
- Don't add Gemini yet — same
- Don't expand to >2 LLMs — F.1 MVP is 2 LLMs (Claude + GPT-4o-mini)

---

## Task 2 — Finish Hermod outreach fix (~1 day)

**Goal:** Fix Hermod's "no candidates" output for commercial topics by adding a multi-query SERP path that doesn't depend on Loki gaps + SERP snapshots.

### Why this needs fixing

**Current Hermod logic** (in `src/lib/agents/hermod.ts`):
1. Pulls Loki gap actions from last 14 days
2. For each gap keyword, looks up `serp_snapshots` table for SERP results
3. Filters top-20 results, excludes competitors + existing prospects
4. Top 2 candidates per keyword get pitched via Claude

**The problem:**
For commercial topics like "YouTube Premium Accounts", "Steam Wallet Gift Cards", "Roblox Robux", the SERP top 20 is dominated by direct G2G competitors (Kinguin, Eneba, MMOGA, etc.). After filtering competitors, **zero editorial sites remain**. Hermod returns "no candidates" forever for these topics.

**Diagnosis confirmed (Opus session, 2026-05-04):**
- Hermod runs regularly (8 runs in last 14 days verified)
- 4 of 8 returned "Scanned 2 keyword gaps — no new candidates"
- 3 of 8 returned "No recent X keyword gaps to work with"
- 1 returned "Loki has never run for X" (chicken-and-egg dependency)
- Pattern is genuinely "topic isn't editorial-fit" — not a bug per se

### Solution — Path B: editorial-intent SERP search

**Insight:** Editorial sites (GuruGamer, Polygon, GameRant, IGN, etc.) don't rank for buy-intent queries. They rank for **editorial-intent variations** of the same topic.

For topic "Diablo 4 Items":
| Query | SERP top results |
|---|---|
| `"diablo 4 items"` (current Hermod) | g2g, kinguin, eneba (marketplace) |
| `"diablo 4 items guide"` | gurugamer, gamerant, polygon (editorial) |
| `"best diablo 4 items"` | gameranx, kotaku, ign (editorial) |
| `"diablo 4 item tier list"` | gamesradar, dexerto, eurogamer (editorial) |

Domains appearing in **2+ editorial-intent queries** = strong outreach candidates.

### Implementation steps

**Step 1: Add path B to `src/lib/agents/hermod.ts`** (~3 hours)

Modify the main flow:
1. After existing path A (Loki-gap-driven SERP lookup), add path B for **published-brief-driven editorial search**
2. Query published briefs from last 30 days that have no outreach prospects yet:
   ```sql
   SELECT brief.id, brief.primary_keyword
   FROM seo_content_briefs brief
   LEFT JOIN outreach_prospects p ON p.source_keyword = brief.primary_keyword
   WHERE brief.status = 'published'
     AND brief.published_at >= NOW() - INTERVAL '30 days'
     AND p.id IS NULL
   ```
3. For each candidate keyword, generate 3 editorial-intent query variations:
   ```ts
   const editorialQueries = [
     `${keyword} guide`,
     `${keyword} tier list`,        // game-specific; use "review" for non-game topics
     `best ${keyword}`,
   ]
   ```
4. Use `getSerpData` (already in `src/lib/dataforseo/client.ts`) for each query — top 10 results each
5. Aggregate domains across queries — score by frequency (`appearances >= 2` = strong candidate)
6. Filter as before (skip G2G + competitors + existing prospects)
7. Pitch top 2 per topic via Claude (same flow as path A)

**Step 2: Topic relevance gate** (~1 hour)

Some topics are not editorial-fit at all. Skip them upfront to save quota:

```ts
function isEditorialEligibleTopic(keyword: string): boolean {
  // Topics likely to have editorial coverage
  const editorialMarkers = [
    /\b(diablo|fortnite|wow|world of warcraft|osrs|runescape|genshin|marvel|hero siege|carx|forza|arknights|league of legends|dota|csgo|cs:?go|valorant|apex|overwatch)\b/i,
    /\b(game|gaming|account|item|currency|gold|gear|build|tier|level|class|skill|raid|boss|quest|loot)\b/i,
  ]
  // Topics unlikely to have editorial coverage (commercial-only)
  const commercialOnlyMarkers = [
    /\b(gift card|wallet|top.?up|robux|v.?bucks|premium|subscription)\b/i,
  ]

  if (commercialOnlyMarkers.some(re => re.test(keyword))) return false
  return editorialMarkers.some(re => re.test(keyword))
}
```

If `!isEditorialEligibleTopic(keyword)`, mark the brief in agent_findings with `finding_type='outreach_not_applicable'` and skip — don't waste API calls.

**Step 3: UX message fix** (~30 min)

Currently `src/app/api/pipeline-journey/route.ts` (around line ~536-544) returns:
```ts
stageOutreach = {
  status: 'active',
  summary: 'Hermod searching for outreach prospects…',
  detail: 'Runs automatically after publish. Check back after next Hermod cron.',
  ...
}
```

This message is dishonest if Hermod has already searched and found nothing. Update logic:
- If brief is published > 48h AND zero prospects: change message to `"No editorial-fit prospects found · this topic may not suit gaming editorial sites"` with a CTA `Add manually` (link to `/outreach/new` if it exists, or just `/outreach`)
- Add an `outreach_not_applicable` flag check — if true, message changes to `"Outreach skipped — topic not editorial-fit"` with no warning emoji

**Step 4: Manual prospect entry** (~2 hours)

Currently no UI to manually add a prospect. Build a minimal one:
- New page `/outreach/new/page.tsx` with form: domain, contact name, contact email, source_keyword (defaults from `?keyword=` query param), anchor text, notes
- POST to existing `/api/outreach/prospects` (already supports POST per `outreach/prospects/route.ts`)
- "Add manually" CTAs from Pipeline UI link here with prefilled keyword

### Verification

After implementation:
- Trigger a Hermod run via Command Center or `agents-scheduler.yml` workflow_dispatch
- Check `agent_runs` table — Hermod summary should now mention path A vs path B counts
- Check `outreach_prospects` table — new domains should appear for previously-orphan topics like Diablo 4 Items
- Open Pipeline Journey, navigate to a published topic that previously showed "Hermod searching..." → should now show prospects OR "no editorial fit · add manually"

### What NOT to change in Hermod fix

- Don't add DataForSEO Backlinks API — user explicitly said no budget for monthly commitment (2026-05-04 decision). The multi-query SERP approach uses existing `getSerpData` which kalian sudah pake.
- Don't refactor Hermod's existing path A logic — just add path B alongside. Path A still useful for editorial-friendly topics.
- Don't change `outreach_prospects` schema — UNLESS you're adding `editorial_score` field to track why a prospect was selected (which is optional).

---

## After both tasks done

Update HANDOFF-NEXT.md with status. Either:
- Mark these tasks as ✅ done and add new pending items
- Replace this file with the next session's handoff

Plus run the verification routine in HANDOFF.md §0.3:

```bash
md5sum src/app/api/ai/chat/route.ts src/components/dashboard/AIAssistant.tsx
npx tsc --noEmit
npx eslint <touched files>
```

Update PRESENTATION-NOTES.md PR tracker section to reflect:
- Frey F.1: ✅ deployed (was 🚧)
- Hermod outreach fix: ✅ done (was ⏳ pending)

---

## Other parked items (don't pick these up unless time)

- Frey F.2 (Bragi/Tyr/Vor integration) — defer until F.1 stable for ≥2 weeks
- Frey F.3 (weekly/monthly report sections) — defer until F.2 done
- 5 effect-tracking metrics (revenue per article, competitive diff, branded search, backlink verify, cluster authority) — high impact but ~3 days work; pick up if user explicitly requests
- Discovery hooks → Topic Detail Page (Brief Library, Editorial Calendar, Writer Inbox) — 30-min cleanup, do if you have time after main tasks
- Blog post brief stuck investigation — parked, lower priority

---

## Quick reference

**Project root:** `/Users/galih/Documents/Claude/Projects/Individual SEO Tools/g2g-seo-tools`
**App URL:** `https://g2g-seo-tools.vercel.app`
**Supabase project:** main / production
**Slack channel:** `#writer-rangers`
**Owner email:** `galih.priambodo@g2g.com`
**Daily briefing schedule:** weekday 07:00 WIB (00:00 UTC) via Cowork scheduled task `daily-pipeline-briefing`
**agents-scheduler GH cron:** every 30 min, runs all 8 agents
**process-briefs GH cron:** every 10 min, picks up stuck briefs
**bing-daily GH cron:** every 23:30 UTC (just before daily briefing)
**frey-weekly GH cron:** every Sunday 18:00 UTC (after deployed)

**Key env vars (Vercel):**
- `CRON_SECRET` — auth for all cron endpoints
- `ANTHROPIC_API_KEY` — Claude calls
- `OPENAI_API_KEY` — needed for Frey (currently MISSING — user adds in Task 1)
- `SUPABASE_SERVICE_ROLE_KEY` — DB writes
- `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID` — `#writer-rangers` posts
- `G2G_OWNER_USER_ID` — galih's auth.users.id
- `BING_WEBMASTER_API_KEY` + `BING_SITE_URL`
- `FIRECRAWL_API_KEY` — page analyzer + brief generation

**End of handoff. Good luck.**
