# AI Visibility Roadmap — Frey Agent

**Status:** Design locked, deferred for implementation. Phase E (Bing Webmaster) implemented first as foundation.

## Decisions made (2026-05-04 session)

### LLM scope (MVP)
3 LLMs: **Claude (Anthropic), GPT-4o-mini (OpenAI), Perplexity Sonar**.
- Skip Gemini at MVP — add in F.2 if budget allows.
- Cost projection: ~$30/month for weekly runs.

### Prompt scope
**30 curated prompts**, weekly run cadence.
- Source: top G2G category topics + brand-related queries.
- Prompts to be defined during F.1 implementation (collaborate with SEO team).

### Flows (all 4 in Phase F.1 MVP)
1. **Flow 1 — AI Invisibility Detection** → emit agent_actions to existing pipeline
2. **Flow 2 — Sentiment Shift Alert** → Slack alert on negative deltas
3. **Flow 5 — Bragi Brief Content Guidance** → enrich brief generation prompts with AI context
4. **Flow 6 — Vor Measure AI Delta** → track 30/60/90 day AI visibility lift post-publish

## Architecture (planned)

### Database tables
```sql
ai_visibility_findings (
  id, owner_user_id, site_slug, run_id,
  llm_platform,                -- 'claude' | 'gpt-4o-mini' | 'perplexity-sonar'
  prompt_id, prompt_text,
  brand_mentioned   boolean,
  brand_position    integer,    -- 1=first, 2=second, ...
  sentiment         numeric,    -- -1.0 to +1.0
  competitors       jsonb,      -- [{domain, mention_count, position}]
  raw_response      text,       -- full LLM response (for audit)
  observed_at       timestamptz
)

ai_visibility_snapshots (
  id, owner_user_id, site_slug,
  topic_slug,                   -- aggregated per pipeline topic
  week_starting    date,
  visibility_score numeric,     -- 0-100 composite
  mention_rate     numeric,     -- % of prompts where mentioned
  avg_position     numeric,     -- across mentioned prompts
  avg_sentiment    numeric,
  top_competitor   text,        -- who dominates this topic
  prompt_coverage  integer,     -- # prompts in this topic this week
  created_at       timestamptz
)

ai_visibility_prompts (
  id, owner_user_id, site_slug,
  prompt_text,
  topic_slug,                   -- maps to existing pipeline topic
  category,                     -- 'brand', 'product', 'comparison', 'how-to'
  active           boolean,
  created_at, updated_at
)
```

### Files to build
```
src/lib/agents/frey.ts                      # main agent runner
src/lib/llm-clients/openai.ts               # OpenAI client (new)
src/lib/llm-clients/perplexity.ts           # Perplexity client (new)
src/lib/llm-clients/parser.ts               # response parser (Haiku-based)
src/app/api/cron/frey-weekly/route.ts       # GH Actions trigger endpoint
.github/workflows/frey-weekly.yml           # weekly cron (Sundays 18:00 UTC)
src/app/(dashboard)/ai-visibility/page.tsx  # dashboard
src/app/api/ai-visibility/route.ts          # data API for dashboard
supabase/migrations/add_ai_visibility.sql   # tables + indexes
```

### Required env (new)
```
OPENAI_API_KEY                 # for GPT-4o-mini
PERPLEXITY_API_KEY             # for Sonar
ANTHROPIC_API_KEY              # already exists, reuse
```

## Phase split (rough estimate)

| Phase | Scope | Effort |
|---|---|---|
| **F.1** | Frey MVP: Flow 1+2 (detection + alert), tables, LLM clients, dashboard page | ~1 day |
| **F.2** | Bragi/Tyr/Vor integration (Flow 5+6) | ~1 day |
| **F.3** | Weekly + monthly report sections + dashboard widgets | ~half day |

**Total:** ~2.5 days from green-field to fully operational.

## Cost projection (steady state)

| Component | Monthly |
|---|---|
| 30 prompts × 3 LLMs × 4 weeks (LLM responses) | ~$15-20 |
| Response parsing (Haiku, 1 call per response) | ~$5-8 |
| Storage (Supabase) | $0 (free tier OK) |
| **Total** | **~$20-30/month** |

10x cheaper than Profound dkk. No monthly commitment.

## Pre-conditions before F.1 implementation

- [ ] Phase E (Bing Webmaster) deployed and stable — Bing data feeds Frey context
- [ ] OpenAI API key + Perplexity API key obtained, added to Vercel env
- [ ] Initial 30 prompt list curated by SEO team (template provided in F.1 PR)
- [ ] Topic mapping confirmed (which prompt → which pipeline topic_slug)
- [ ] Sentiment threshold defined (default: alert if drops > 0.3 in 7d)

## Reporting integration (F.3)

**Weekly report adds:**
- AI Visibility Score line chart (4 weeks)
- Top 5 movers (positive + negative deltas)
- Top 3 prompts where G2G displaced by competitor
- Top 3 USP under-mentioned
- 3-5 recommended brief topics from Frey gaps

**Monthly report adds:**
- 12-week trend
- Content created vs AI gaps closed (correlation analysis)
- Per-topic deep dive (top 3 topics, full audit)
- Competitor evolution (who's gaining AI mindshare)

## Future considerations (post-F.3)

- Add Gemini Flash to LLM mix for Google AI Overviews proxy
- Reddit citation tracking (Reddit heavily influences LLM training data)
- Wikipedia presence audit + improvement plan
- Schema markup audit per topic
- Multi-language AI visibility (BR, ID, MY markets)
- Direct integration with content brief generation: brief explicitly targets AI gaps

---

_Document last updated: 2026-05-04 — locked decisions, deferred implementation._
