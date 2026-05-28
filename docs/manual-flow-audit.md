# Manual Flow Audit — G2G SEO Tools

*Last updated: 14 May 2026*

A complete inventory of every step in the SEO workflow that still requires a human touch, classified by automation status + projected effort to fully eliminate.

---

## Legend

- 🟢 **Auto** — fully automated, no human needed
- 🟡 **Semi-auto** — human triggers, tool runs
- 🔴 **Manual** — full human effort
- 🎯 **Target state** — what it should look like post-automation

---

## 1. Content Production

### Product Content Pipeline

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| BDT types "yes" in sheet col E | 🟡 Semi | Trigger that fires AI generation | ⚡ Low — replace with cron that auto-marks priority products as "yes" weekly |
| AI generates EN + ID content | 🟢 Auto | Claude Haiku 5-min cron, ~10min lead | — |
| Write to sheet (EN + ID tabs) | 🟢 Auto | Auto-create ID tab if missing | — |
| Upload to G2G CMS | 🟢 Auto | 3-call CMS API (marketing+SEO+FAQ EN+FAQ ID) | — |
| JWT refresh (weekly) | 🔴 Manual | Galih pastes new token from G2G admin | 🟡 Medium — needs G2G dev to expose long-lived OAuth or service token (out of our control) |
| Brief review for top tier | 🟡 Semi | Tyr scores, human approves/rejects | ⚡ Low — `tyr_autopublish_config` per tier (DONE in Sprint PRESENT.10) |

🎯 **Target:** non-tier products are 100% hands-off after first KB setup. Tier 1 retains lightweight approve-with-1-click step.

### Brief Generation (Bragi)

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| Opportunity creation | 🟢 Auto | Heimdall/Loki/Odin signals → Saga aggregator | — |
| Brief generation from opportunity | 🟡 Semi | Queue via "Push to Bragi" button | ⚡ Low — auto-push when opp.signal_count ≥ 3 AND opp.matched_relation_id IS NOT NULL |
| Brief review & approval | 🟡 Semi | Editor opens brief, edits, approves | ⚡ Low — same auto-publish config as product content (PRESENT.10) |
| Content delivery to writer | 🟡 Semi | Manual share link / email | 🟢 Done via Writer Inbox + auto-assign |

🎯 **Target:** for non-Tier-1 opportunities, brief generation → auto-approve → writer inbox = zero human action between Heimdall signal and writer pickup.

---

## 2. Detection Agents

### Currently auto

- **Heimdall** (ranking drops) — 🟢 daily cron
- **Loki** (keyword gaps) — 🟢 weekly cron via DataForSEO
- **Odin** (Steam trends) — 🟢 weekly cron via DataForSEO + Steam
- **Bifrost** (gaming news) — 🟢 every 6h cron via RSS + Haiku
- **Saga** (signal aggregator) — 🟢 auto on every signal insert

### Still semi/manual

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| Approve agent runs for cost-sensitive flows | 🟡 Semi | Mimir asks confirm before triggering Hermod (cost ~$5/run) | ✋ Keep manual — explicit cost approval is a feature, not bug |
| Categorize opportunities (output_type) | 🟢 Auto | Pipeline-journey auto-assigns by SERP signals + Loki rank | — |
| Match opportunity → tier product | 🟢 Auto | Fuzzy matcher in Saga aggregator (Sprint CATALOG.14) | — |

---

## 3. Outreach (Backlinks)

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| Find link gaps vs competitor | 🟢 Auto | Backlink Gap tool + DataForSEO | — |
| Score domains (Hermod) | 🟢 Auto | DA + relevance score | — |
| Compose outreach email | 🟢 Auto | Claude generates personalised opener | — |
| Send email | 🔴 Manual | Galih/team copy-paste into Gmail | 🔴 High — needs Gmail OAuth + send-as wiring + spam-filter management |
| Reply handling | 🔴 Manual | Track replies, classify (yes/no/maybe), follow up | 🟡 Medium — needs Gmail inbox monitor + classifier |
| Guest post drafting | 🟡 Semi | AI generates draft, human polishes | ⚡ Low — auto-publish via Tyr threshold once writers trust the output |
| Publishing on partner site | 🔴 Manual | Partner publishes after we send draft | 🚫 Out of our control |

🎯 **Target:** automate send + reply classification. Hold off on auto-send until reply-rate data shows it's safe.

---

## 4. Knowledge Base / Configuration

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| KB rules input (DOs, DON'Ts, forbidden claims) | 🔴 Manual | Team curates per category | ✋ Keep manual — domain expertise required |
| Category list maintenance | 🔴 Manual | Add/edit KB category rows | ✋ Keep manual |
| Tier list (top 10 / top 25) selection | 🔴 Manual | Galih + team review traffic + business priority | ✋ Keep manual — strategic call |
| Tier keyword input | 🔴 Manual | Per product, 3-10 keywords | ⚡ Low — auto-suggest from GSC top-queries + DataForSEO clusters |
| Sheet config (per brand spreadsheet ID) | 🔴 Manual | One-time setup | ✋ Keep manual — needs Drive access |
| News export sheet config | 🔴 Manual | One-time setup | ✋ Keep manual |

🎯 **Target:** automate tier keyword discovery only. Leave strategic config in human hands.

---

## 5. Reporting & Monitoring

| Step | Status | Detail | Eliminate effort |
|---|---|---|---|
| Weekly report generation | 🟢 Auto | PPTX builder + Drive upload + Slack post Monday 01:00 UTC | — |
| Monthly report | 🟡 Semi | PPTX exists, manual review before sending | ⚡ Low — auto-send once trusted |
| Daily Slack alerts (ranking drops) | 🟢 Auto | Tier rank alerts cron | — |
| Weekly tier summary Slack | 🟢 Auto | Sprint NOTI.1 — runs Monday 03:00 UTC | — |
| Weekly news + trends export | 🟢 Auto | Sprint NEWS_EXPORT.10 — Monday 01:00 UTC to configured Sheet | — |
| Weekly agent performance digest | 🟢 Auto | Sprint PRESENT.4 — Monday 02:00 UTC to #team-marketing | — |
| Ad-hoc reports for stakeholders | 🔴 Manual | Compile in PPTX, share | ⚡ Low — `/reports/*` pages are publicly shareable now |

---

## Summary

**Manual flows that block end-to-end automation:**

1. ⚠ **JWT refresh** (weekly, 5 min) — blocked by G2G CMS infra (long-lived token not available)
2. ⚠ **Tier 1 brief review** — by design, until quality threshold validated (Sprint PRESENT.10 lets us flip the switch per tier)
3. ⚠ **Outreach email send** — held intentionally until reply-rate data confirms safety
4. ⚠ **Tier list strategy** — by design, human strategic call

**Manual flows that could be eliminated in next sprint (~2-3 days each):**

1. Auto-mark priority products as "yes" → fully removes BDT sheet input
2. Auto-push opportunities to Bragi when signal threshold + relation_id match
3. Auto-suggest tier keywords from GSC top queries
4. Auto-send monthly report (after 2 months of quality validation)

**Out-of-scope (external infrastructure):**

1. Partner site publishing (we send drafts, partners publish manually)
2. Long-lived G2G CMS auth (depends on G2G dev team)

---

## Quick wins for next 2-week sprint

| Item | Effort | Impact |
|---|---|---|
| Enable `tyr_autopublish` for non-tier products | <1 day | Removes ~80% of brief reviews |
| Auto-push opportunities ≥3 signals + tier-matched | 1 day | Eliminates manual "Push to Bragi" clicks |
| Auto-suggest tier keywords from GSC | 2 days | Removes manual keyword input |
| Auto-mark Tier 1 products for content generation | 1 day | BDT no longer needs to type "yes" |
