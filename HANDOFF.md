# Project Handoff — g2g-seo-tools

Status snapshot for the next agent (Sonnet or otherwise) picking up this codebase.

---

## 0. Critical constraints — read this first

### 0.1 Files that MUST NOT be modified — UNLESS specifically scoped to Mimir feature work

The following two files belong to the "Mimir The All Knowing" interactive
chatbot. They are normally OFF-LIMITS — most tasks should never touch them.

```
src/app/api/ai/chat/route.ts
src/components/dashboard/AIAssistant.tsx
```

**Default rule:** any task NOT explicitly scoped to "Mimir feature work" must
leave both files unchanged. Verify with md5 after every batch of edits.

**Reference md5s as of last unchanged baseline:**
```
src/app/api/ai/chat/route.ts                    af90bef16ef3e3a6f8f5d7d224617612
src/components/dashboard/AIAssistant.tsx        d5e7eb0f1c637c0cdce5afec5301bb0d
```
_(Updated after §10 Mimir agent-trigger implementation — Sonnet session 2026-04-28)_

```bash
md5sum src/app/api/ai/chat/route.ts src/components/dashboard/AIAssistant.tsx
```

**Exception — scoped Mimir feature work:** if your task description explicitly
authorises modifying these files (e.g. "build the Mimir agent-trigger feature"
in §10 below), then md5 changes are EXPECTED. In that case:

1. Re-read §10 spec carefully before editing.
2. After implementation, recompute the md5s and update them in this file.
3. Run `md5sum` and paste the new values into the "Reference md5s" block above
   so future unrelated tasks have a fresh baseline to verify against.
4. Don't expand scope. If your task is "add agent trigger tool," don't also
   refactor the chat layout or change unrelated tools. Stay surgical.

### 0.2 Mimir vs. Vor naming

- **Mimir** = the chatbot (AIAssistant.tsx). Do NOT touch.
- **Vor** = the config-tuner agent (formerly named Mimir, renamed to avoid collision).
  - Source: `src/lib/agents/vor.ts`
  - Legacy: `src/lib/agents/mimir.ts` is a re-export stub kept for safety. Can be
    deleted once you've confirmed nothing imports `'@/lib/agents/mimir'`. Run:
    ```bash
    grep -r "agents/mimir" src/
    ```
    Should return only the stub itself.

### 0.3 Verification routine

After every batch of edits:

```bash
# 1. AI Assistant unchanged
md5sum src/app/api/ai/chat/route.ts src/components/dashboard/AIAssistant.tsx

# 2. Type check
npx tsc --noEmit

# 3. Lint touched files
npx eslint <touched files>
```

A pass = both md5s match the values above + tsc has 0 output + eslint has 0 NEW
errors (pre-existing warnings/errors in unrelated files are okay — confirm by
diff against a clean checkout if unsure).

### 0.4 Vercel Hobby plan limit

Vercel Hobby allows max 2 daily crons. Heavy schedulers live on GitHub Actions
(`.github/workflows/agents-scheduler.yml`, runs every 30 min). Don't add new
Vercel cron jobs without checking the count.

---

## 1. What this is

Next.js 16 (App Router) SEO tools dashboard for **G2G.com** — a peer-to-peer
gaming marketplace. Solo + team SEO + writers + executives all use it.

**Stack:**
- Next.js 16 App Router (`src/app/(dashboard)/...`, `src/app/api/...`)
- Supabase Postgres (RLS via `createClient`, service-role via `createServiceClient` for backend)
- Anthropic Claude SDK with `tool_use` for structured output
- DataForSEO + SEMrush + GA4 + GSC APIs
- Slack Block Kit + Interactive endpoint with HMAC-SHA256 verification
- pptxgenjs / sharp for report exports
- tsx + node:test for smoke tests

**Hosting:** Vercel (Hobby) + GitHub Actions for cron.

---

## 2. The Norse agent system

Eight named agents. Each has a clear responsibility. All inherit a common
contract: write to `agent_runs` (status), optionally queue actions in
`agent_actions` (approval queue), and persist raw output to `agent_findings`
(the discovery feed, see §3).

| Agent     | Role                          | Source                              | Page consumer                            |
|-----------|-------------------------------|-------------------------------------|------------------------------------------|
| Heimdall  | GSC ranking-drop watchdog     | `src/lib/agents/heimdall.ts`        | `/gsc/ranking-drop`                      |
| Loki      | Competitive analysis (SoV+gaps)| `src/lib/agents/loki.ts`           | `/competitive/competitors`, `keyword-gap`|
| Odin      | Trending games spotter         | `src/lib/agents/odin.ts`            | `/content/trends`                        |
| Bragi     | Content brief drafter          | `src/lib/agents/bragi.ts` + `brief-generator.ts` | `/content/briefs/*`        |
| Tyr       | Brief quality reviewer (8-dim) | `src/lib/agents/tyr.ts`             | `/content/briefs/[id]`, `BriefQualityReview.tsx` |
| Hermod    | Outreach prospect finder       | `src/lib/agents/hermod.ts`          | `/outreach`                              |
| Saga      | Keyword universe curator       | `src/lib/agents/saga.ts`            | `/content/keyword-map`                   |
| Vor       | Config threshold tuner         | `src/lib/agents/vor.ts`             | `/command-center/tuning`                 |

**Approval flow:**
agent → `agent_actions` (status='pending') → user approves in `/command-center` →
`executor.ts` runs the action → writes to domain table (briefs / outreach_prospects
/ keyword_map_clusters / etc.). The Slack integration mirrors this via
`/api/slack/interactive`.

**Critical pre-conditions:**
- Hermod depends on Loki gaps from last 14d. If stale, Hermod queues a `run_agent`
  action to re-trigger Loki first (see `hermod.ts` line 80-110).
- Tyr depends on briefs at status='agent_generated' (Bragi output).
- Saga reads from agent_actions of last 30d to find candidate keywords.

---

## 3. The unified `agent_findings` table (NEW — built this session)

**Migration:** `supabase/migrations/agent_findings.sql` — must be applied to prod.

**Why it exists:** Until this session, agents only wrote to `agent_actions`. If a
user never approved an action, all the raw research the agent did (SoV snapshot,
keyword gaps, drop analysis, cluster proposals) was effectively thrown away —
only `agent_runs.summary` survived. This table captures everything for the page
consumers to read regardless of approval state.

**Schema:**
```sql
agent_findings (
  id, owner_user_id, agent_key, run_id, site_slug,
  finding_type,   -- agent-specific, e.g. 'keyword_gap' / 'drop_analysis' / 'cluster_proposal' / 'tune_recommendation' / 'trend_score' / 'prospect_discovered' / 'sov_snapshot' / 'competitor_summary' / 'archive_candidate' / 'coverage_gap'
  subject,        -- main entity (keyword, page URL, cluster name, etc.)
  severity,       -- 'high' | 'medium' | 'low' | 'info' | null
  data,           -- jsonb, shape varies per (agent_key, finding_type)
  observed_at
)
```

**Helper:** `src/lib/agents/findings.ts` exports `persistFinding(...)` and
`persistFindingsBulk(...)` plus canonical type definitions for each agent's
finding shape (`LokiKeywordGapData`, `HeimdallDropAnalysisData`, etc.).

**Read API:** `GET /api/agents/findings?agent=...&type=...&severity=...&since=...&run_id=...&limit=N`

**UI components built on top:**
- `LokiFindingsPanel` — `/competitive/competitors`, `/competitive/keyword-gap`
- `HermodFindingsPanel` — `/outreach` Discovery tab
- `SagaProposalsPanel` — `/content/keyword-map`
- `OdinScoringPanel` — `/content/trends`
- `VorRecommendationsPanel` — `/command-center/tuning`
- Heimdall: rendered inline in `RankingDropTable` (badge per row + verdict in expanded panel)

---

## 4. What was done in the most recent session

**Phase A-F: Per-agent findings persistence + page widgets** (see §3).

**Plus 4 follow-up fixes:**

1. **Hermod auto-queue SERP snapshot.** Previously emitted passive warning when
   `serp_snapshots` was empty. Now queues a high-priority action item linking
   to `/competitive/serp-tracker?keywords=X,Y,Z` — user clicks once, snapshot
   runs, next Hermod cron finds prospects. Files: `hermod.ts`, `serp-tracker/page.tsx`.

2. **Tyr→Bragi regen actually uses Tyr's breakdown.** Previously executor only
   forwarded redflags as a string. Now the FULL breakdown (per-dimension scores
   + comments, strengths, weaknesses, prioritised suggestions) flows
   executor → bragi → draft_brief.data → executor approve → brief-generator.
   The brief-generator prompt now includes a structured "⚠ THIS IS A REGEN"
   block listing failing dimensions, weaknesses to fix, prioritised suggestions,
   and strengths to preserve. Files: `executor.ts`, `bragi.ts`, `brief-generator.ts`.

3. **Brief Library `/content/briefs`.** New index page listing all briefs from
   `seo_content_briefs` with filters (status, Tyr verdict, score band, keyword,
   date range), copy-as-markdown button, mark-published button. Tyr-approved
   briefs were previously only reachable via direct URL. Files:
   `(dashboard)/content/briefs/page.tsx`, `BriefLibraryClient.tsx`,
   `api/content/briefs/[id]/route.ts`, `Sidebar.tsx`.

4. **Weekly report compact ActionPunchList at top.** New top section: max 6
   punchy bullets (top dropper, Tyr failed briefs, pending actions, SEMrush
   keyword drops, broken instrumentation, revenue drop) with severity colours
   and "Go →" deep links. The existing AI Narrative + Issues & Shortcomings
   + Agent Activity Summary were moved BELOW under a "📖 Full analysis"
   divider. Files: `(dashboard)/reports/weekly/page.tsx`.

---

## 4b. What was done in the Sonnet session (after Opus handoff)

**SEO tooling gap-fill (separate from agent system):**

1. **Broken URL Monitor** (`/content/broken-urls`). API + 3-tab UI: broken
   pages (4xx/5xx from crawl), lost from GSC (historical impressions now 0),
   broken outlinks (live pages linking to dead destinations).
   Files: `api/broken-urls/route.ts`, `(dashboard)/content/broken-urls/page.tsx`.

2. **Cannibalization Detector** (`/content/cannibalization`). GSC query+page
   data, Jaccard similarity, split-score, severity tiers, keyword-map overlap
   detection. Files: `api/cannibalization/route.ts`, `(dashboard)/content/cannibalization/page.tsx`.

3. **Internal Links Manager** (`/content/internal-links`). Crawl-based orphan
   detection (< 3 inbound links), link opportunity finder, link-map tab with
   colour-coded inlink counts. AI anchor-text suggestions via Mimir.
   Files: `api/internal-links/route.ts`, `(dashboard)/content/internal-links/page.tsx`.

4. **Content ROI Tracker** (`/reports/content-roi`). GA4 purchase-event
   revenue + organic sessions per published cluster. Landing-page vs on-page
   attribution toggle. Files: `api/content-roi/route.ts`, `(dashboard)/reports/content-roi/page.tsx`.

5. **Multi-Market Dashboard** (`/reports/multi-market`). US vs ID (or any two
   markets) side-by-side: keyword comparison, content gaps, rank opportunities.
   Extends GSC client with `getSearchAnalyticsByCountry()`.
   Files: `api/multi-market/route.ts`, `(dashboard)/reports/multi-market/page.tsx`.

6. **Keyword Map** (full UI, `/content/keyword-map`). Complete UI over the
   backend built by Opus: map list, tree/table toggle, 4 modals, status flow,
   "Add to Map" buttons wired into Trends + Keyword Gap + Clicks Drop pages.

7. **Writer Brief Inbox** (`/content/writer-inbox`). Clean, jargon-free queue
   for writers: ready/in-progress/published cards, outline preview, copy-brief,
   mark-published. No Tyr scores, no agent labels visible.
   Files: `(dashboard)/content/writer-inbox/page.tsx`, `WriterInboxClient.tsx`.

8. **Editorial Calendar** (`/content/calendar`). Month-view calendar + pipeline
   view (4 kanban columns). Briefs placed on `target_publish_date`. Inline
   reschedule date picker. Mark-published inline.
   Files: `(dashboard)/content/calendar/page.tsx`, `EditorialCalendarClient.tsx`.
   New migration: `supabase/migrations/add_brief_publish_date.sql`.
   PATCH `/api/content/briefs/[id]` extended: now accepts `target_publish_date`
   and `notes` fields in addition to `status`.

9. **Ranking Impact Tracker** (`/reports/ranking-impact`). GSC position
   snapshots at publish · +30d · +60d · +90d per published brief. Auto-seeds
   when brief is marked published (fire-and-forget in briefs PATCH endpoint).
   Manual snapshot button. Trend sparkline, position delta indicators.
   Files: `api/brief-outcomes/route.ts`, `(dashboard)/reports/ranking-impact/page.tsx`.
   New migration: `supabase/migrations/add_brief_outcomes.sql`.

**Cleanup done:**
- `mimir.ts` stub still present but confirmed zero imports → safe to delete.

**Migrations added this Sonnet session (apply in order):**
```bash
psql "$DATABASE_URL" -f supabase/migrations/add_brief_publish_date.sql
psql "$DATABASE_URL" -f supabase/migrations/add_brief_outcomes.sql
```

---

## 5. What's NOT done — pending work for next session

### High priority

1. **Mimir agent-trigger tool** — see §10 for the full spec. Opus wrote the
   entire design; Sonnet is tasked with implementing it end-to-end.

2. **Onboarding wizard + tooltips + empty states for new logins.**
   First-time tour by role (SEO / writer / executive). Right now empty pages
   say "no data" without explaining how to populate them.

### Previously high priority — now DONE

- ~~Writer-focused brief inbox~~ → built as `/content/writer-inbox`
- ~~Editorial calendar~~ → built as `/content/calendar`
- ~~Ranking impact tracker~~ → built as `/reports/ranking-impact`

### Medium priority

5. **Vor what-if preview + bulk approve.** Before approving a `tune_config`
   action, show simulated impact ("would have flagged 2 fewer drops last
   week"). Bulk approve: select multiple actions in queue, approve in one
   click. Keyboard shortcuts (j/k navigate, a approve, r reject).

6. **Cost dashboard polish.** Per-agent daily spend chart (we have totals;
   daily breakdown missing). Per-action cost ("this Tyr review cost
   $0.0023"). Source: `api_usage_logs` × `anthropic-pricing.ts`.

### Deferred by design — revisit after 4-6 weeks of pipeline data

> **Context (Galih, 2026-04-29):** The current weekly/monthly reports were built before
> the full 7-agent pipeline existed. They should be refactored once the pipeline has
> been running long enough to have meaningful data (≥ 4-6 weeks). Don't rush this —
> a pretty report with empty data is worthless.

**Huginn & Muninn — future reporting agents (do NOT build yet):**

Norse mythology: Odin's two ravens — Huginn (Thought) scouts the world, Muninn (Memory)
remembers everything they saw. In our pipeline:
- **Huginn** = actively synthesises fresh pipeline signals (pulls from all 7 agent outputs
  + GSC + GA4, composes a narrative, highlights what changed this week)
- **Muninn** = remembers and tracks historical outcomes (knows what we shipped, what
  ranked, what we promised; provides the longitudinal view)

These two agents replace the current static weekly/monthly report pages with a
fully data-driven synthesis. Only worth building after the pipeline (Heimdall → Vor)
has 1-2 months of real data in `agent_findings`, `agent_runs`, `brief_outcomes`, etc.

Build order when ready:
1. Refine `/reports/weekly` and `/reports/monthly` pages to pull from `agent_findings`
   (Vor outcomes, Heimdall drops recovered, Bragi briefs published, Hermod links acquired)
2. Build Huginn as a synthesis agent (weekly run, pulls all pipeline data, outputs
   a structured `WeeklyNarrative` with sections + action callouts)
3. Build Muninn as a memory agent (tracks cumulative KPIs, YoY/MoM deltas,
   content investment vs. traffic return)
4. Huginn + Muninn together power the report pages instead of the current manual queries

---

### Lower priority / cleanup

7. **Apply ActionPunchList to monthly report.** Different `ReportData` shape
   from weekly — needs separate work. Skipped this session to avoid breaking.
   File to extend: `(dashboard)/reports/monthly/page.tsx`.

8. **Delete `src/lib/agents/mimir.ts` re-export stub.** Verify with
   `grep -r "agents/mimir" src/` — if only the stub itself appears, delete it.

9. **Apply `agent_findings.sql` migration to prod.**
   ```bash
   supabase db push
   # or
   psql "$DATABASE_URL" -f supabase/migrations/agent_findings.sql
   ```

10. **Re-run all agents once after migration.** So the findings tables get
    populated and the new page widgets show real data instead of empty
    states.

### Bug investigations (open as of last session)

- **Hermod still showing "no candidates" warning** even after the fix — needs
  verification on prod. The fix queues an actionable item now; verify the
  action shows up in `/command-center` after Hermod's next run.
- **SEMrush keyword tracking returning zero** — surfaced in weekly report.
  Likely auth or quota issue with SEMrush API. Check `/command-center/health`
  endpoint and `api_usage_logs` for SEMrush errors.

---

## 6. Architecture cheat sheet

### Approval queue vs. findings feed

| Concern              | `agent_actions`                | `agent_findings`               |
|----------------------|--------------------------------|--------------------------------|
| Purpose              | "Should we ACT on this?"       | "What did the agent see?"     |
| Lifecycle            | pending → approved/rejected → executed | append-only (history)  |
| Volume               | curated subset (1-50/run)      | full discovery (10s-100s/run) |
| Page surface         | Approval Queue (Command Center)| Per-domain pages (panels)     |
| Approval needed?     | Yes                            | No                             |

### Common code paths

**When user approves an `agent_action`:**
1. UI calls `/api/agents/actions/[id]/approve` (or `/api/slack/interactive`)
2. Endpoint calls `executeAction(action, approverId)` in `src/lib/agents/executor.ts`
3. Executor switches on `action.action_type`:
   - `add_action_item` → insert into `seo_action_items`
   - `draft_brief` → insert into `seo_content_briefs` + run `generateAgentBrief`
   - `regenerate_brief` → mark old brief draft + spawn new Bragi run with `previous_review`
   - `draft_outreach` → insert into `outreach_prospects`
   - `add_to_cluster` / `create_topic_map` → insert into `keyword_map_clusters` / `keyword_maps`
   - `archive_cluster` → flip cluster `status='archived'`
   - `tune_config` → update `agents.config` + write `agent_config_history` row
   - `run_agent` → spawn the target agent's run (handoff/refresh)
4. Mark action `status='executed'` with `approved_by` + `executed_at`

**When an agent runs (any agent):**
1. Cron / manual trigger / approval handoff calls `runX(ownerId, siteSlug, runId, ...)`
2. Agent does its work
3. Persists findings to `agent_findings` (one or more `findingType`s per run)
4. Optionally queues `agent_actions` for human approval
5. Calls `_finishRun()` to update `agent_runs` + `agents` (last_run_at)

### Tyr regen feedback loop (NEW this session — IMPORTANT)

```
Tyr scores brief 60/100 (failed)
  → queues regenerate_brief action with `data.tyr_breakdown` (full 8-dim review)

User approves the action
  → executor reads `data.tyr_breakdown`
  → builds structured `previousReview = { score, dimensions, strengths,
                                            weaknesses, suggestions, reasoning }`
  → calls `runBragi(...)` with `handoffPayload.previous_review = previousReview`

Bragi handoff mode receives previousReview
  → forwards into `draft_brief` action's data field

User approves the draft_brief action (or it auto-approves)
  → executor passes `data.previous_review` to `generateAgentBrief({...previousReview})`

brief-generator's `buildPrompt` calls `buildRegenFeedbackBlock(previousReview)`
  → injects "⚠ THIS IS A REGENERATION" block listing failing dimensions
    + weaknesses + prioritised suggestions + strengths to preserve
  → Claude prompt now has structured guidance to fix specific issues
```

### Brief lifecycle states

`seo_content_briefs.status` values:
- `generating` — brief-generator is currently working on it
- `agent_generated` — Bragi finished, awaiting Tyr review
- `reviewed` — Tyr passed it (score ≥ minScore, default 80) — **ready to write**
- `draft` — manual edit / failed regen / writer working on it
- `published` — finalised, content shipped

`seo_content_briefs.tyr_status` values:
- `reviewed` — passed (≥ minScore)
- `borderline` — within `borderlineWindow` of minScore
- `failed` — below `minScore - borderlineWindow`
- `error` — Tyr's Claude call itself errored

---

## 7. Style conventions

- Dark theme tokens: `text-white`, `text-gray-400`, `bg-gray-900`, `border-gray-800`
- Severity colours: red-900/40 (high), amber-900/40 (medium), blue-900/40 (low)
- Norse mythology naming for agents — keep this consistent. New agents should
  pick a Norse god/figure with a fitting role.
- Comments in source files explain WHY, not what. Especially around non-
  obvious decisions (failure modes, schema design choices, dedupe logic).
- Indonesian language is fine in UI text + commit messages where the user is
  Indonesian. Code identifiers stay English.

---

## 8. Useful commands

```bash
# Type check (fast)
npx tsc --noEmit

# Lint specific files
npx eslint <files>

# Run a single agent for testing
node scripts/run-agent.js loki      # if exists
# Or trigger via UI: /command-center → Start Patrolling

# E2E smoke test (mock Supabase)
node scripts/test-loki-e2e.cjs

# Check AI Assistant intact
md5sum src/app/api/ai/chat/route.ts src/components/dashboard/AIAssistant.tsx

# Find all imports of a renamed symbol
grep -r "agents/mimir" src/

# Check what action types executor handles
grep "action.action_type === " src/lib/agents/executor.ts
```

---

## 9. Open questions to confirm with user before changing

1. **Migration apply timing.** `agent_findings.sql` — has it been applied to
   prod yet? If not, panels will show empty states until it is + agents are
   re-run.
2. **Monthly report.** Apply `ActionPunchList` pattern? Different schema means
   non-trivial work.
3. **Writer inbox vs. Brief Library merge.** The Brief Library is technical
   (status badges, Tyr scores, agent metadata). Should writers get a
   simplified separate view, or filtered tabs in the same page?
4. **Ranking impact tracker.** Auto-track all published briefs, or opt-in per
   brief? Storage cost grows with brief count × 4 snapshots.

---

## 10. SCOPED FEATURE — Mimir agent-trigger tool (FOR SONNET TO IMPLEMENT)

**Status:** spec'd, NOT YET BUILT. The user has explicitly scoped this work to
the next coding session and authorised modifying the AI Assistant files (see
§0.1 exception clause). Build this end-to-end. Do not partial-implement. Do
not skip any of items 1-5 below.

### 10.1 The problem

Mimir (the chatbot) currently has 7 read-only tools — it can answer questions
about agent state but cannot trigger runs. User wants to be able to say
"run Loki" / "trigger Hermod" in chat and have Mimir actually do it, with a
confirmation step in the UI before any side effect happens.

### 10.2 Agent classification (use this everywhere — tool description, UI labels, cost calc)

The 8 agents are grouped into 3 categories. Use these labels consistently
across the new tool, the cost-warning logic, and any UI affordances.

| Category          | Agents                       | Side-effect profile                      | Default cooldown |
|-------------------|------------------------------|------------------------------------------|-----------------|
| **Detection**     | Heimdall, Loki, Odin         | External API calls (DataForSEO, SEMrush, GSC, Steam) — most expensive in $ terms | 3 hours |
| **Execution**     | Bragi, Hermod, Saga          | Claude calls + DB mutations (queues actions, may insert briefs/prospects/clusters) | 1 hour |
| **Review/Control**| Tyr, Vor                     | Claude calls only, no external APIs; analyse our own data | 30 minutes |

Cooldown = "ran less than X ago counts as recently-run, surface a cost warning
in the confirmation prompt." It is NOT a hard block — user can still confirm
and proceed.

**Hard block** (don't allow trigger at all): if the agent currently has an
`agent_runs` row with `status='running'` and no `finished_at`, show a "currently
running" message and refuse to fire a second run.

### 10.3 Design decisions made (don't re-litigate, just implement)

1. **Confirmation always required.** Mimir never auto-fires. Every trigger
   shows a confirmation prompt with the last-run info first.
2. **One generic tool, three categories surfaced via metadata.** Not per-agent
   tools.
3. **Two-layer rate limit:** confirmation always (layer 1) + cost warning if
   within cooldown window (layer 2). User can override the warning.
4. **No new Slack notifications for Mimir-triggered runs.** Agents' own
   internal Slack notifs (notifyTyrEvent, etc.) still fire as normal — don't
   suppress those. We just don't add a new "Mimir triggered Loki" notif.
5. **Yes/No buttons rendered as UI components in the chat,** not as text
   "y/n". Click = button event; clicking Yes triggers the run via a separate
   backend endpoint (NOT a second LLM call — see §10.5 architecture).

### 10.4 Files to touch

- `src/app/api/ai/chat/route.ts` — add new tools `propose_agent_run` and
  (optionally) `list_runnable_agents`. Both READ-only — they don't trigger
  anything; they return metadata Claude uses to compose the confirmation
  message.
- `src/components/dashboard/AIAssistant.tsx` — add UI affordance: when an
  assistant message contains a confirmation payload (see §10.5 wire format),
  render a yellow/amber confirmation card with Yes/No buttons. On Yes,
  call new endpoint (§10.6). On No, post a "Cancelled" assistant message.
- `src/app/api/ai/confirm-agent-run/route.ts` — NEW. Receives a confirmation
  payload from the Yes click, validates it, fires the run, returns the run_id.
  Decoupled from Claude — the LLM is NOT in the loop for the actual fire.
- (no changes to individual agent files — the run trigger goes through the
  existing run-spawn pattern used by `/api/agents/run/[name]` or equivalent;
  reuse what's there.)

### 10.5 Wire format & flow

**Step 1 — User asks to trigger:**
```
User: "Run Loki"
```

**Step 2 — Claude calls `propose_agent_run({ agent: 'loki' })`:**
The tool returns READ-ONLY metadata. Tool implementation pseudocode:
```typescript
async function propose_agent_run({ agent }) {
  // 1. Validate agent name against allowlist:
  //    ['heimdall','loki','odin','bragi','hermod','saga','tyr','vor']
  // 2. Look up category from the table in §10.2
  // 3. Query agent_runs for the most recent run for this agent + ownerId:
  //    select started_at, finished_at, status, summary
  //    order by started_at desc limit 1
  // 4. Compute:
  //    - is_running = status === 'running' && !finished_at
  //    - hours_since_last = (now - started_at) / 3600000
  //    - within_cooldown = hours_since_last < cooldown_for_category
  //    - cost_warning = within_cooldown
  // 5. Generate a short confirmation_token (random uuid)
  //    Store in a transient table or in-memory map keyed by token, with
  //    payload { agent, ownerId, expires_at = now + 5min }
  //    (RECOMMENDATION: small `mimir_pending_triggers` table, ttl-pruned)
  // 6. Return:
  return {
    agent,
    category,                              // 'detection' | 'execution' | 'review_control'
    last_run: { started_at, finished_at, status, summary },
    is_running,
    cost_warning,                          // boolean
    cooldown_hours: 3 | 1 | 0.5,           // by category
    hours_since_last: 3.2,
    confirmation_token: 'mimir-trig-...',  // expires in 5 min
    ui_directive: {
      type: 'confirm_agent_run',
      agent,
      cost_warning,
      confirmation_token,
    },
  }
}
```

**Step 3 — Claude composes assistant text:**

Claude's system prompt should be updated to teach it:
- When user asks to run an agent, ALWAYS call `propose_agent_run` first.
- Embed the `ui_directive` JSON object in the response, wrapped in a marker:
  ```
  Loki was last run 3.2 hours ago (status: success).
  ⚠ Within cooldown — running again now will incur extra DataForSEO + SEMrush API cost.

  <<<MIMIR_CONFIRM>>>{"type":"confirm_agent_run","agent":"loki","cost_warning":true,"confirmation_token":"mimir-trig-abc123"}<<</MIMIR_CONFIRM>>>
  ```
- If `is_running === true`, do NOT emit the confirm marker; just say "currently running, wait until it finishes" and stop.

**Step 4 — Frontend renders Yes/No buttons:**

In `AIAssistant.tsx`, when rendering an assistant message, parse out any
`<<<MIMIR_CONFIRM>>>...<<</MIMIR_CONFIRM>>>` block. Don't show the raw JSON.
Render a styled confirmation card below the assistant text:

```
┌──────────────────────────────────────────────┐
│  ⚠ Confirm: trigger Loki?                    │
│                                              │
│  Last run: 3.2h ago (success)                │
│  ⚠ Cost warning — within 3h cooldown.        │
│                                              │
│  [ Yes, trigger ]   [ Cancel ]               │
└──────────────────────────────────────────────┘
```

Visual style: amber border + bg if `cost_warning`, gray border otherwise.
Use existing dark theme tokens (`bg-amber-900/30`, etc.). The `[Yes]` button
is `bg-red-700` (matches existing CTA style); `[Cancel]` is `bg-gray-800`.

**Step 5 — On click:**

- `[Cancel]` → just append a synthetic assistant message "✗ Cancelled. No
  agent triggered." No backend call.
- `[Yes, trigger]` → call `POST /api/ai/confirm-agent-run` with body
  `{ confirmation_token }`. On 200, append synthetic assistant message
  "✓ Loki started. Run ID: xyz. Use 'agent insights' to check progress in a
  few minutes." On 400/500, append error message.

After clicking either button, the confirmation card should remove itself or
become visually disabled (don't allow re-clicking).

### 10.6 Backend endpoint `/api/ai/confirm-agent-run`

NEW file: `src/app/api/ai/confirm-agent-run/route.ts`

```typescript
// POST /api/ai/confirm-agent-run
// Body: { confirmation_token: string }
//
// Validates the token (must exist, not expired, owned by current user).
// Fires the run by inserting an agent_runs row (status='running') and
// invoking the appropriate runX function (or POSTing to the existing
// /api/agents/run/[name] endpoint — pick whichever is the canonical
// trigger path; reuse, don't duplicate).
//
// Returns: { ok: true, run_id, agent }
```

Implementation notes:
- Auth: same pattern as other `/api/ai/*` routes — `createClient` +
  `getEffectiveOwnerId`.
- Token validation: look up the pending trigger; if not found / expired /
  wrong ownerId → 400 "invalid or expired confirmation".
- After firing: delete the pending trigger row (one-time use).
- Use the existing run-spawn pattern. Look at how `/api/agents/run/[agent]/route.ts`
  (if it exists) or how `executor.ts` spawns runs (the `run_agent` action_type
  branch is the closest reference). Reuse that code path; do NOT call the
  agent's `runX` function directly inline (it's slow + ties up the request).

### 10.7 Schema addition

Add a small migration: `supabase/migrations/mimir_pending_triggers.sql`

```sql
CREATE TABLE IF NOT EXISTS mimir_pending_triggers (
  token          text PRIMARY KEY,
  owner_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_key      text NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mimir_pending_triggers(owner_user_id, expires_at);

ALTER TABLE mimir_pending_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only"
  ON mimir_pending_triggers FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
```

Tokens TTL = 5 minutes. Don't bother with periodic cleanup — let
`expires_at < now()` filter handle it on read; rows accumulate slowly enough
that a manual cleanup is fine.

### 10.8 System prompt update

In `route.ts`, the system prompt currently lists the 7 read-only tools. Add
a section about agent triggering. Sample copy:

```
TRIGGERING AGENT RUNS:
You can propose triggering one of the 8 SEO agents (heimdall, loki, odin,
bragi, hermod, saga, tyr, vor) on the user's behalf. Workflow:

1. When the user asks to run / trigger / kick off an agent, call the
   propose_agent_run tool with the agent name. NEVER skip this step.
2. The tool returns last-run metadata + a confirmation_token. Use this to
   compose a short, factual reply: which agent, when it last ran, what the
   last run's status was, and whether there's a cost warning (recently run).
3. ALWAYS embed the returned ui_directive in your reply between the markers
   <<<MIMIR_CONFIRM>>> and <<</MIMIR_CONFIRM>>>. The frontend parses these
   markers to render Yes/No buttons. Without them, the user has no way to
   confirm.
4. Do NOT generate the confirmation_token yourself — only the value the
   tool returns is valid.
5. If the tool returns is_running=true, refuse politely and don't emit a
   confirmation marker. Suggest the user wait or check progress via
   get_agent_insights.

Example reply (cost warning case):
"Loki was last run 3.2h ago (status: success — found 12 insights). It's
within the 3-hour cooldown for detection agents, so re-running now will
charge additional DataForSEO + SEMrush API calls. Confirm to proceed.
<<<MIMIR_CONFIRM>>>{...json...}<<</MIMIR_CONFIRM>>>"
```

### 10.9 Edge cases to handle

1. **User asks to trigger an unknown agent** ("run odyssey") → tool returns
   error, Claude apologises + lists valid agents.
2. **User confirms after token expired (>5 min)** → endpoint returns 400 with
   message "confirmation expired, ask Mimir to propose again." Frontend
   renders the error and removes the (now invalid) button.
3. **User has no permission** (different ownerId than token) → 403, treat as
   expired/invalid.
4. **User clicks Yes twice** (race condition) → token deletion in the endpoint
   makes second click 400 invalid. Frontend should disable the button after
   first click but defence-in-depth on the backend matters.
5. **User asks to "run all agents"** → Claude should NOT batch-confirm. It
   should propose them ONE at a time, OR refuse and explain the cooldowns.
   Pick: refuse, suggest they go to Command Center for bulk control.

### 10.10 Acceptance checklist (Sonnet — verify all before declaring done)

- [ ] Migration applied locally and committed
- [ ] `propose_agent_run` tool added to `route.ts` system tools array
- [ ] System prompt updated with the new TRIGGERING section
- [ ] `/api/ai/confirm-agent-run/route.ts` created and tested with curl
- [ ] AIAssistant.tsx parses `<<<MIMIR_CONFIRM>>>` markers and hides the raw
      JSON from the rendered text
- [ ] Yes/No buttons render with correct styling (amber if cost warning, gray
      otherwise)
- [ ] Yes button calls the endpoint and appends success/error message
- [ ] Cancel button appends "Cancelled" message without backend call
- [ ] Buttons disable after first click (don't allow re-fire)
- [ ] Hard-block path: `is_running=true` → no confirm marker emitted
- [ ] Cost-warning path: amber styling + correct hours display
- [ ] tsc clean, eslint clean on touched files
- [ ] After implementation, **recompute md5s of the two AI Assistant files**
      and update §0.1 "Reference md5s" block in this HANDOFF.md so future
      tasks have a fresh baseline.
- [ ] Test: chat "trigger loki" — see card, click Yes, verify run starts
      (check `agent_runs` table for new row).
- [ ] Test: chat "trigger loki" again immediately — see "currently running"
      message, NO confirm card.
- [ ] Smoke-test ALL 8 agents (heimdall, loki, odin, bragi, hermod, saga,
      tyr, vor) trigger via chat. Each should propose, confirm, fire.

### 10.11 Things explicitly OUT OF SCOPE for this task

Do NOT do these as part of the agent-trigger work — they're separate
follow-ups already on the backlog:

- "Run all agents" / chained orchestration. Single-agent only for v1.
- Per-agent custom args (e.g. "run Heimdall with minClicksDrop=10"). Use
  default config only.
- Slack notification for Mimir-triggered runs. Silent.
- Showing run progress in the chat (streaming). Just return run_id and
  point the user at `get_agent_insights` for progress.
- Adding a "Trigger Loki" quick-action button somewhere in the dashboard
  UI. This task is chat-only.
- Refactoring any of the 7 existing read-only tools.

---

## 11. Deferred by design — Huginn & Muninn reporting agents

Two reporting agents to build **after 4–6 weeks of real pipeline data** exists in `agent_findings`, `brief_outcomes`, etc.

- **Huginn** (Thought) = synthesises fresh pipeline signals weekly — what's moving, what's stalled, where to push
- **Muninn** (Memory) = tracks cumulative KPIs and historical outcomes — did the briefs we approved actually improve rankings?

Do NOT build these yet. The data foundation needs to mature first.

---

## 12. Multi-site isolation — OffGamers (NEW — full audit done 2026-04-29)

**Context:** The app supports G2G + OffGamers via a site switcher. Architecture is designed for multi-site (`site_slug` column exists on most tables), but the implementation is incomplete. A full audit was done and revealed 26 critical issues where data is NOT isolated per site.

**Golden rule for all OffGamers work:** Every API query on a table that has `site_slug` MUST include `.eq('site_slug', siteSlug)`. No exceptions. If the column doesn't exist on a table yet, add a migration first.

**Tasks #19–28 in the task list cover everything. Open a dedicated chat for OffGamers work.**

### 12.1 What's already site-aware ✅
- `seo_opportunities` — all queries filter by `site_slug`
- `weekly_reports` — filters by `site_slug`
- `agent_actions` — filters by `site_slug`
- `pipeline-journey` API — filters by `site_slug`
- `getSiteUrlForSlug()` in `src/lib/agents/site-helpers.ts` — works for both sites
- Agents (Heimdall, Loki, Odin, Hermod) accept `siteSlug` param

### 12.2 Critical gaps to fix 🔴

**Task #19 — Client-side site context hook**
- `src/app/(dashboard)/command-center/pipeline/page.tsx` hardcodes `site=g2g` in fetch URL
- Build `useSiteSlug()` hook reading from SiteSwitcher, inject into all client fetch calls

**Task #20 — Remove all `?? 'g2g'` API defaults**
- 16 routes still default to g2g if site param missing:
  - `src/app/api/backlinks/audit/route.ts`
  - `src/app/api/reports/weekly/route.ts`
  - `src/app/api/reports/monthly/route.ts`
  - `src/app/api/opportunities/route.ts`
  - `src/app/api/serp-features/route.ts`
  - `src/app/api/agents/actions/route.ts`
  - `src/app/api/agents/[key]/run/route.ts`
  - `src/app/api/pipeline-journey/route.ts`
  - `src/app/api/pipeline-journey/approve/route.ts`
  - `src/app/api/agents/aggregate/route.ts`
  - `src/app/api/ai/confirm-agent-run/route.ts`

**Task #21 — Outreach prospects isolation**
- `outreach_prospects` table has no `site_slug` column → all 6 outreach routes mix data across sites
- Need DB migration + filter in all routes under `src/app/api/outreach/`

**Task #22 — Content briefs isolation**
- `seo_content_briefs` may lack `site_slug` → all `/api/brief/*` routes filter by `owner_user_id` only
- Routes: `/api/brief/generate`, `/api/brief/update`, `/api/brief/add-ideas`, `/api/brief/keywords`, `/api/brief/generate-draft`, `/api/content/briefs/[id]/*`

**Task #23 — Agent data isolation**
- `agent_findings`, `agent_runs`, `agent_actions` queries without `site_slug`:
  - `src/app/api/agents/findings/route.ts`
  - `src/app/api/agents/needs-attention/route.ts`
  - `src/app/api/agents/insights/route.ts`
  - `src/app/api/agents/performance/route.ts`
  - `src/app/api/agents/status/route.ts`
  - `src/app/api/system/health/route.ts`
  - `src/app/api/ai/chat/route.ts` (Mimir — but note §0.1 restriction)

**Task #24 — Action items + brief outcomes isolation**
- `seo_action_items`, `brief_outcomes` routes missing site filter:
  - `src/app/api/actions/route.ts`
  - `src/app/api/actions/export/route.ts`
  - `src/app/api/tools/url-analysis/route.ts`
  - `src/app/api/brief-outcomes/route.ts`
  - `src/app/api/dmca/scan/route.ts`

**Task #25 — Fix cron jobs to iterate all sites**
- `src/app/api/cron/agents-scheduler/route.ts` — `const siteSlug = 'g2g'` (hardcoded, not a default)
- `src/app/api/cron/weekly-report-generator/route.ts`
- `src/app/api/cron/monthly-report-generator/route.ts`
- Fix: query `site_configs` table, iterate all active sites

**Task #26 — Knowledge Base per site**
- `knowledge_base_items` scoped to `owner_user_id` only — G2G and OffGamers share KB
- Add `site_slug` column; update KB API routes + `loadKBBlock()` in `brief-generator.ts`
- Note: `brand` category may remain shared; `category` and `platforms` must be per-site

**Task #27 — Bragi prompt branding**
- `src/lib/agents/brief-generator.ts` ~line 259: hardcoded `"Buy & Sell on G2G"` fallback
- Replace with site-aware brand name from KB or site_configs

**Task #28 — OffGamers site_config**
- OffGamers needs row in `site_configs`: `gsc_property`, `semrush_project_id`, `dataforseo` settings, `default_country`, `default_language`
- Coordinate with Galih for the correct OffGamers GSC property URL

### 12.3 Recommended order of execution

1. Task #28 — site_config first (prerequisite for everything)
2. Task #19 — client-side hook (unblocks frontend testing)
3. Task #20 — remove API defaults
4. Tasks #21–24 — table-by-table isolation (can parallelize)
5. Task #25 — cron jobs (lowest risk, do last)
6. Tasks #26–27 — KB + Bragi (polish, do after core isolation works)

---

_Last updated: §11 Huginn/Muninn deferred, §12 OffGamers multi-site isolation audit (2026-04-29)._
