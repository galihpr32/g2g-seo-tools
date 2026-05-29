# Backlog — Sprint Queue + Known Gaps

> Snapshot: 2026-05-17
> 190 sprints shipped. Sprint queue prioritized below.

---

## Sprint queue (recommended order)

### Wave 1 — High leverage, ship first

**Sprint FREYJA Phase 1** — AI Visibility tracker *(~1 hour)*
- Why first: Friday KPI's biggest blind spot (currently zero AI metrics in digest)
- Migration: `ai_visibility_snapshots` table
- Lib: `src/lib/agents/freyja.ts` (Bing AI Performance + Semrush AI Visibility aggregator)
- Page: `/reports/ai-visibility`
- Cron: daily Bing, weekly Semrush
- Integration: AI Visibility section added to Friday KPI digest

**Sprint COMPETITIVE.SCORER** — Real keyword scoring code *(~45 min)*
- METHODOLOGY page describes SV × density × intent formula but no actual code exists
- Friday KPI currently uses ALL tier kws as proxy; this sprint adds real scoring
- New file: `src/lib/scoring/competitive-keyword.ts`
- Optional DB: `keyword_volume_cache` for DataForSEO Keyword Data API results
- Integration: Friday KPI most-competitive section uses scored top 50

### Wave 2 — Polish + UX wins

**Sprint MIMIR.POLISH** *(~30 min)*
- HTML fetch retry/fallback for Cloudflare 502s
- Job timeout fallback (auto-fail after 10 min stuck)
- Memory dedupe across runs

**Sprint UI.POLISH** *(~30 min, batched)*
- Mimir Memory admin: surface market filter
- Rankings dashboard: kw_count column on per-product summary
- Friday KPI: empty state handling when no tier products exist for brand
- Cowork preview: auto-expand when rows present

**Sprint AB.REFINE** *(~30 min)*
- Cohort gating (block readouts when < 30 briefs)
- Attribution window: 14d → 28d for clicks settling
- Cost-adjusted ROI delta display (Sonnet vs Haiku per brief)

### Wave 3 — Advanced automation

**Sprint DMCA.AUTO** *(~1 hour)*
- AI agent scans SERP top 20 for tier products
- Auto-flags suspicious patterns (no own_domain, all listing-site competitors)
- Restriction trend tracking (when does HoYoverse-class title typically rank-decay)
- Surfaces "suggested" restriction_type in admin UI for manual confirmation

**Sprint COST.MULTI** *(~45 min)*
- Multi-API cost dashboard (DataForSEO + Semrush + Anthropic in one view)
- Per-owner cost ceilings table (vs current global env var)

**Sprint FREYJA Phase 2** *(~1 hour)*
- Per-LLM drop alerts (citations down ≥X% WoW)
- Competitive AI visibility (us vs competitor brands in AI answers)
- Topic-level breakdown (which queries cite us)

### Wave 4 — Foundation cleanup

**Sprint TECH.DEBT** *(~1.5 hour batched)*
- Type safety on Supabase clients (replace `as any` casts with generated DB types)
- Error response shape consistency across routes
- JSDoc Sprint tags on touched files
- Smoke tests for critical paths (brief gen, tier alerts, cost agg)

**Sprint DOCS.PLATFORM** *(~1 hour batched)*
- Platform README (top-level)
- Integration graph diagram (which agent feeds which)
- Ops runbook (rotate Anthropic key, add new market, onboard new brand)
- DB schema doc (canonical reference for all tables)

---

## Active blockers / external dependencies

### Cowork integration (Sections 3-5 of HANDOFF_COWORK_INTEGRATION.md)
**Owner**: parallel chat session (NOT this one)
**Status**: Vercel-side changes shipped. Cowork chat can proceed.
**Pending from their side**:
- `/api/products/auto-content/cowork-pending` endpoint
- `/api/products/auto-content/cowork-submit` endpoint
- Cowork-side scheduled task
- 3-row manual approval gate
- Slack summary to channel C05V8QG8V99

**Our side fully ready**:
- `runPendingForOwner` matches 'yes' only → Cowork rows skipped by Anthropic cron
- COWORK_TASK_PROMPT_DRAFT.md secrets redacted
- `/api/products/cowork-preview` read-only sheet scan
- CoworkPreviewPanel on /content/products

---

## Parked / on hold

### Multi-market expansion (TH / VN / re-adding DE / FR / MY)
**Status**: parked for 3 months. Revisit ~August 2026.
**Reason**: focus on monitoring current US + ID performance compounding before adding complexity.
**Decision criteria for un-parking**:
- US + ID compounding shows sustained 3-month positive growth trajectory
- AI Visibility (Freyja) reveals strong cross-market demand signals
- Team bandwidth available without sacrificing existing market quality
**What would be needed when revisited**:
- tier_keywords language enum expansion ('en' | 'id' | 'th' | 'vi')
- DATAFORSEO_ACTIVE_MARKETS env update
- Friday KPI traffic country mapping (e.g. country=tha → TH bucket)
- Slack routing per (brand × new_market)
- Mimir scoping per new market

---

## Known gaps (not sprint-worthy yet, but documented)

### Friday KPI v2
- Real "most competitive keyword" scorer → captured as Sprint COMPETITIVE.SCORER
- SV threshold filter → depends on COMPETITIVE.SCORER
- ID country-split working via GSC OAuth (verified)
- Idempotency on cron failure: low risk currently, address if it bites

### DMCA / restriction system
- Manual flag → automation captured as Sprint DMCA.AUTO

### ID-native A/B experiment
- Currently functioning. Refinements in Sprint AB.REFINE.

### UI minor
- All bundled into Sprint UI.POLISH

---

## Watch list (might become work later)

- **Bing Webmaster AI Performance API** — if API access opens, pull citations into our DB (currently dashboard-only)
- **Google AI optimization guide updates** — bookmark, revisit quarterly for strategy-affecting changes
- **MoB (memory of brand) abstraction** — Mimir is per-site; higher-level brand memory across markets would help if/when multi-market un-parks
- **Cowork plugin marketplace** — if our platform becomes a Cowork plugin, needs metadata + distribution flow

---

## Documentation gaps (covered by Sprint DOCS.PLATFORM)

- Platform README
- Integration graph diagram
- Ops runbook
- DB schema doc

---

## Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-15 | Per-tier AI model routing (Opus T1, Sonnet T0/T2, Haiku translation) | Cost cut ~74% with no quality loss where it matters |
| 2026-05-15 | DataForSEO markets pruned to US + ID | Cost discipline; other markets had thin signal |
| 2026-05-15 | DMCA per-product, not per-market | Restriction is product-property, propagated across market rows |
| 2026-05-15 | A/B test ID-native vs EN-translate (50/50 T1+T2) | Test whether native ID generation outperforms translation |
| 2026-05-15 | Cost alert thresholds: $28 warn / $35 critical | Model-tier rollout projects ~$26/mo at 200 articles |
| 2026-05-16 | Per-market tier rows (TIER.PER.MARKET) | US bestsellers ≠ ID bestsellers — tier 1 list is market-specific |
| 2026-05-16 | Per-keyword language assignment | EN keywords track US only, ID keywords track ID only — implicit alignment via `marketsForKeyword()` |
| 2026-05-17 | Multi-market expansion parked 3 months | Monitor US + ID compounding first, revisit ~Aug 2026 |
| 2026-05-17 | Sprint FREYJA proposed | Friday KPI's AI Visibility blind spot is the biggest single gap |
