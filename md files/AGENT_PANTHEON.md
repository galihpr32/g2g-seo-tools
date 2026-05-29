# Agent Pantheon — Norse Mapping

> Internal reference: which Norse god maps to which agent + what it does in the codebase.
> Used for LinkedIn branding (sneak peek post May 2026) and internal team comms.

---

## The squad

### 🧠 Mimir — institutional memory
**Norse**: god of wisdom; counsel-keeper to the Aesir; his head whispered advice to Odin even after death.

**In the codebase**:
- `src/lib/agents/mimir-memory.ts` — retrieve + extract (post-conversation)
- `src/lib/agents/mimir-memory-seed.ts` — auto-seed from tier + KB + brief outcomes
- `src/lib/agents/mimir-onpage-learner.ts` — pattern extractor across 6 dimensions
- `src/lib/agents/mimir-council.ts` — multi-perspective reasoning
- DB: `mimir_memories` (scoped by site_slug + optional market column)

**Functions**:
- Learns house style from best-performing pages (6 dimensions: H1, intro, H2 cadence, trust signals, CTAs, link density)
- Persists durable facts/rules/preferences across conversations
- Scoped by site + optional market — no cross-brand leakage
- Pinned + importance-weighted retrieval

---

### 🎭 Bragi — the bard / writer
**Norse**: god of poetry, eloquence, and skaldic verse.

**In the codebase**:
- `src/lib/agents/brief-generator.ts` — main brief pipeline
- `src/app/api/brief/generate/route.ts` — entry point
- `src/lib/anthropic/model-tier.ts` — per-tier model selection
- `src/lib/agents/id-native-generator.ts` — native Indonesian variant

**Functions**:
- Generates SEO briefs end-to-end (outputType: on_page, new_page, blog_post, off_page)
- Per-tier model routing: Opus for T1 strategic, Sonnet for T2/T0, Haiku for translation
- Catches long-tail variations + PAA patterns + fan-query angles
- KB hard enforcement + forbidden claims check
- Diff-style output for optimize_existing
- 50/50 A/B variant: native ID write vs EN-translate

---

### ⚖️ Tyr — the gatekeeper
**Norse**: god of law, justice, and oaths.

**In the codebase**:
- `src/lib/agents/tyr.ts` — quality review
- `src/lib/agents/tyr-autopublish.ts` — autopublish threshold
- DB: `tyr_autopublish_config`
- `/settings/tyr-autopublish` — admin UI

**Functions**:
- Reviews every brief before it ships
- Auto-publishes when quality threshold met (configurable per workspace)
- Flags below-threshold briefs for human review
- Logs to brief_review_feedback for the learning loop

---

### 👁️ Heimdall — the watchman
**Norse**: guardian of the Bifrost bridge; can see and hear all nine realms.

**In the codebase**:
- `src/app/api/cron/gsc-daily/route.ts` — daily watcher cron
- `src/lib/gsc/tier-detect.ts` — tier-aware drop detection (Sprint GSC.T1.DOD)
- `src/lib/slack/alerts.ts` — sendTieredRankingDropAlert
- `src/lib/slack/tech-item-alert.ts` — real-time tech item alerts (Sprint TECH.REALTIME)

**Functions**:
- Monitors Tier 1 pages day-over-day (10% drop trigger)
- Monitors Tier 2 + non-tier weekly (15% drop with 4-day GSC freshness lag)
- DMCA-aware: surfaces restriction context in alerts ("drop expected")
- Real-time alert on new high/critical tech items
- All-clear messaging when nothing fires

---

### 📬 Hermod — the scout / messenger
**Norse**: Odin's messenger who rode to Hel.

**In the codebase**:
- `src/lib/agents/hermod.ts` — outreach orchestration
- `src/lib/agents/hermod-domain-eval.ts` — domain scoring
- `/command-center/off-page` — off-page pipeline page
- `/outreach` — Guestpost Outreach
- `/backlinks` — Backlink Tracker

**Functions**:
- Off-page outreach + backlink monitoring
- Scores prospect domains before outreach (relevance, authority, traffic, content fit)
- Tracks outreach reply funnel
- Feeds opportunities back into the editorial calendar

---

### 📖 Saga — the lorekeeper
**Norse**: goddess of poetry, history, and chronicles; drinking companion to Odin at Sökkvabekkr.

**In the codebase**:
- `src/lib/agents/saga/cluster.ts` — keyword clustering
- Sprint CATALOG.14 — auto-match hook in saga aggregator
- `/clusters` — cluster admin page

**Functions**:
- Keyword clustering — turns thousands of search variants into coherent topic plans
- Prevents cannibalization (no duplicate articles for the same intent)
- Aggregates fragmented opportunities into shippable content plans

---

### 🦅 Odin — the all-knower (+ his ravens)
**Norse**: chief of the Aesir; daily sends his ravens Huginn (thought) and Muninn (memory) to survey the nine realms.

**In the codebase (Odin's responsibilities split across agents)**:
- **Huginn (competitive intel)** — `src/lib/agents/loki.ts` if exists, or competitive monitoring in saga/cluster
- **Muninn (market/trend sensing)** — `src/lib/agents/bifrost.ts` + `bifrost-newsjacking.ts` + `frey.ts` (pricing)
- `/competitive` group pages — keyword gap, serp tracker, content gap
- `/content/news-signals` — news + trend surfacing

**Functions**:
- Competitive intel (Semrush + DataForSEO + SERP tracking)
- News/trends watchlist (Bifrost daily news + newsjacking)
- Pricing intel (Frey weekly)
- Cross-references back into Saga's clustering for "opportunity → content plan"

**Note**: In LinkedIn branding, Loki + Bifrost + Frey are folded under Odin's ravens (Huginn = competitive intel via Loki/competitive agents; Muninn = market/trend via Bifrost + Frey). Internal codebase keeps them as separate modules.

---

## Supporting cast (mentioned in TriggerSource enum, less prominent)
- **Vor** — referenced in api-logger.ts trigger source; possibly internal validation agent
- **Loki** — experimental / wildcard agent (Sprint references suggest competitive analysis)
- **Bifrost** — news bridge (separate from Heimdall the watchman of Bifrost)
- **Frey** — weekly pricing/market sense

---

## Planned (not built yet)

### 🔮 Freyja — the seer / AI Visibility tracker
**Norse**: goddess of seiðr (divination + prophecy); wears a falcon-feather cloak that lets her travel between realms and see what others can't. Different domain from Odin (who sends ravens for ground-level intel) — Freyja sees the unseen patterns.

**Planned in codebase**:
- Migration: `ai_visibility_snapshots` (date, brand, llm_source, mentions, citations, cited_pages, country)
- `src/lib/agents/freyja.ts` — Bing AI Performance + Semrush AI Visibility aggregator
- `/reports/ai-visibility` — dashboard page
- Cron: daily Bing pull, weekly Semrush pull
- Integration: Friday KPI digest gets new AI Visibility section

**Why now**:
- Friday KPI currently has zero AI Visibility surface — biggest blind spot in the digest
- Bing Webmaster + Semrush AI Visibility data already accessible; just needs aggregator + UI
- Phase 2: per-LLM drop alerts + competitive AI visibility (us vs competitor brands in AI answers)

**Status**: Sprint scoped, waiting to ship as Wave 1 priority #1.

---

## Branding rules (for public-facing materials)

1. **Stay true to each god's domain** — Tyr = justice (gatekeeper), Heimdall = watchman, Bragi = poetry/writer. Don't mix up.

2. **Never imply religious significance or appropriation** — these are personality framings for AI agents, comparable to Marvel's Thor.

3. **Female gods exist in the pantheon** — Saga is female (goddess of history). Use she/her in narrative.

4. **Public posts use 7 named figures max** — Mimir, Bragi, Tyr, Heimdall, Hermod, Saga, Odin (+ ravens). Keep Loki/Bifrost/Frey "in the shadows" for tease purposes.

5. **For deeply Norse-knowledgeable audiences** — Huginn/Muninn references reward the lore-aware without alienating others.

---

## Linked TaskList sprints

See PROJECT_LOG.md for full sprint history. Pantheon-specific sprints:
- MIMIR.* (1-10), MIMIR.LEARN, MIMIR.MARKET, MIMIR.ONPAGE
- BRAGI.* (1-10), BRAGI.MODEL.TIER, BRAGI.ID.NATIVE
- PRESENT.9-11 (Tyr autopublish)
- DEBUG.1 (Hermod investigation)
- TECH.REALTIME (Heimdall real-time alerts)
- GSC.T1.DOD (Heimdall tier-aware)
- CATALOG.14 (Saga auto-match)
