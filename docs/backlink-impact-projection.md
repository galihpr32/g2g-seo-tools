# Backlink Automation — Impact Projection

*Last updated: 14 May 2026*

How much of the backlink workflow is already automated, what remains manual, and what the ranking impact looks like before vs after full automation.

---

## TL;DR

- **Discovery + scoring: 100% automated** (Hermod + Backlink Gap)
- **Outreach email generation: 100% automated** (Claude composes personalised opener)
- **Send + reply tracking: still manual** (Gmail integration deferred until reply-rate data confirms safety)
- **Expected impact post full automation:** 3-5× outreach volume per analyst-hour, 15-25% DA gain over 6 months for tier 1 products

---

## Current automation matrix

| Stage | % Automated | Tool | Notes |
|---|---|---|---|
| 1. Competitor referring-domain discovery | 100% | `/competitive/backlink-gap` (DataForSEO) | Pulls competitor backlinks, filters to "they have, we don't" |
| 2. Domain quality scoring | 100% | Hermod agent | DA + relevance + skip-list filtering |
| 3. Outreach prospect compilation | 100% | `/outreach` | Auto-pushed from Hermod findings |
| 4. Personalised email drafting | 100% | Claude `/api/outreach/prospects/[id]/generate-opener` | Reads prospect page + game context |
| 5. **Email send** | **0%** | — (manual copy-paste into Gmail) | Held back intentionally |
| 6. **Reply tracking** | **0%** | — (manual) | Held back intentionally |
| 7. **Follow-up scheduling** | 50% | Cron-driven reminder | Triggers, but human acts |
| 8. Backlink verification (live check) | 100% | `/api/cron/backlinks-verify` weekly | Confirms link is up |
| 9. Backlink reporting | 100% | Weekly report PPTX + Slack | — |

**Score:** 7 of 9 stages fully automated (~78%). The 2 manual stages are intentional, not blockers.

---

## Why send + reply are still manual

**Risk profile:**

1. **Spam-filter penalty** — sending hundreds of cold emails from our domain without a careful sending cadence triggers Gmail's spam classifier, which downgrades ALL future emails from G2G (including legitimate ops emails).
2. **Reputation damage** — bad outreach copy reflects on G2G brand. We need 2-3 months of human-curated send data to confirm Claude's drafts hit the "not annoying" bar before scaling.
3. **No reply-rate baseline** — until we have data on what reply rate our current drafts achieve, we can't auto-send and measure.

**Decision criteria to auto-send:**

- ≥ 30 days of manual-send data with **reply rate ≥ 5%** on Claude-drafted emails
- **Spam complaint rate < 0.1%**
- Gmail send-as auth wired (technical prerequisite)
- Approval from legal/comms on auto-send copy templates

**Timeline:** Best case, full send automation Q3 2026.

---

## Projected impact post automation

### Outreach volume

**Current state (semi-manual):**
- Analyst spends ~30 min per outreach email (find prospect, customize draft, send, log)
- 1 analyst at 4 hours/day on outreach = **8 emails/day = 160 emails/month**

**Post send automation (Hermod cron):**
- Hermod auto-finds 50+ prospects/week
- Claude auto-drafts all 50 in ~5 min total
- Cron sends throttled at safe rate (~10/day per domain) = **300+ emails/month**

**Volume gain: 2-3× per analyst-hour**, with analyst now focused on reply handling + relationship building instead of mechanical send.

### Ranking impact estimate

Based on industry benchmarks for new-link → ranking lift:

| Tier | Current backlinks/month | Projected post-auto | DA gain (est. 6mo) | Ranking impact |
|---|---|---|---|---|
| Tier 1 (Top 10) | 2-3 | 8-12 | +5-8 DA | +3-5 avg position |
| Tier 2 (Next 25) | 1-2 | 4-6 | +2-4 DA | +1-3 avg position |
| Non-tier | 0-1 | 1-2 | +1-2 DA | +0-1 avg position |

Caveats:
- Numbers assume our current outreach quality (~5% reply rate) holds at scale.
- DA is just one signal — content quality + technical SEO matter more for ranking.
- 6-month timeline is conservative; some lift visible in 8-12 weeks.

### Cost/benefit

**Annual analyst-hour savings:**
- Current: 1 analyst × 4 hours/day × 250 days × $25/hr = **$25,000/year on outreach**
- Post auto-send: 1 analyst × 1 hour/day × 250 days × $25/hr = **$6,250/year on outreach**
- **Net saving: $18,750/year** (analyst can reallocate 3 hours/day to higher-value work)

**Infrastructure cost:**
- Gmail API + monitoring: ~$50/month = $600/year
- DataForSEO backlinks calls: ~$30/month = $360/year
- Cron compute (Vercel): negligible

**Net ROI:** ~$17,800/year savings on outreach alone, before counting the ranking impact / revenue uplift.

---

## Recommendation

**Hold full auto-send until Q3 2026.** Until then, focus on:

1. **Track reply rates** on current Claude drafts — establish baseline
2. **Iterate prompt** based on what gets replies (refine Hermod's domain selection + Claude's opener style)
3. **Build Gmail send-as integration** (2-3 day project) so the moment we're confident, we can flip the switch

Meanwhile, manual send + auto-everything-else still represents a **~78% automation rate** for backlinks, which is the right balance for now.

---

## Live data sources

- Real-time prospect list: `/outreach`
- Hermod scoring: `/api/agents/hermod/findings`
- Backlink gap: `/competitive/backlink-gap`
- Backlink verification: `/api/cron/backlinks-verify` (weekly)
- Reports: `/reports/backlinks`
