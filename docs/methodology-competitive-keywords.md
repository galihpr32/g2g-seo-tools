# Methodology — Most Competitive Keyword

> Sprint METHODOLOGY · Last updated: 2026-05

This is the canonical answer to **"kenapa keyword ini paling competitive?"** — useful for stakeholder meetings, onboarding new analysts, or when someone disagrees with the algorithm's pick.

## TL;DR

A keyword wins the **"most competitive"** label inside a cluster when it has the highest blended score of:

```
score = (SV_norm × 0.50) + (Density_norm × 0.30) + (Intent_norm × 0.20)
```

- **Volume** tells us the prize is worth chasing.
- **Density** tells us the SERP is contested (otherwise it's a free win — not competitive, just easy).
- **Intent** tells us a #1 here actually converts.

All three inputs are normalized to 0–100 *within the cluster* before weighting. Result is a 0–100 score; highest wins.

---

## The Three Inputs

### 1. Search Volume (50% weight)

| Property | Value |
|---|---|
| **Source** | DataForSEO Keyword Data API |
| **Markets** | US + ID (filtered by keyword language) |
| **Cache** | 30 days |
| **Normalization** | Linear scale within cluster — max SV → 100, min SV → 0 |
| **Missing-value fallback** | `SV_norm = 50` (so it doesn't zero out the score) |

**Why 50%:** No traffic = no point. Volume is the prize ceiling; everything else just decides whether you can reach it.

### 2. Keyword Density (30% weight — difficulty proxy)

| Property | Value |
|---|---|
| **Source** | `tier_serp_snapshots.top_10` |
| **Definition** | Distinct 2nd-level domains in the top 10 SERP |
| **Computation** | `unique_domains / 10 × 100` |
| **Missing-value fallback** | `Density_norm = 50` |

**Why 30%:** Difficulty alone can lie (one-domain monopoly = easy to challenge), but combined with volume it explains *why* a keyword isn't already won by us or a competitor.

**Note:** Semrush KD is folded in as a secondary signal where available, but is not the primary lens. Our density measure is calibrated to the gaming/digital-goods vertical.

### 3. Intent Alignment (20% weight)

| Intent | Score |
|---|---|
| transactional | 100 |
| commercial | 80 |
| informational | 50 |
| navigational | 30 |

**Source:** Haiku classification on `keyword + top-3 SERP snippets`, cached in `keyword_intent`.

**Why 20%:** Intent matters but doesn't override volume. A high-volume informational keyword still earns its place because it builds topical authority that lifts transactional siblings.

---

## Worked Example — Genshin Impact cluster

| Keyword | SV (mo) | SV_norm | Density | Intent | Score |
|---|---:|---:|---:|---|---:|
| 🏆 **genshin impact top up** | 40,500 | 100 | 90 | 100 (trans) | **94** |
| genshin impact tier list | 33,100 | 86 | 60 | 50 (info) | 71 |
| buy genshin impact genesis crystals | 9,900 | 62 | 80 | 100 (trans) | 75 |
| genshin impact account for sale | 6,600 | 48 | 70 | 80 (com) | 61 |
| genshin impact wiki | 22,200 | 73 | 30 | 30 (nav) | 51 |

**Reading the result:** "genshin impact top up" wins not because it has the highest volume alone (tier list is close), but because it pairs that volume with a saturated SERP (density 90) AND transactional intent (100). All three signals stack.

Tier list has decent volume but low intent → ranks 3rd.
Wiki has high volume but lopsided everything else → ranks last.

---

## Edge cases

### DMCA-restricted products
Genshin and Honkai post-HoYoverse takedowns still score normally — the score reflects **opportunity**. Whether we can *execute* is a separate flag on the product (`product_tiers.restriction_type`). The badge surfaces this in the dashboard so the score isn't read as actionable when it isn't.

### Brand-new keywords
Keywords with no DataForSEO SV yet get `SV_norm = 50` (mid) and are marked **provisional** in the UI. They're re-scored after the next monthly volume refresh.

### ID vs EN markets
Evaluated independently. The ID cluster has its own "most competitive" winner. Cross-market comparison is not meaningful because SERP density differs systematically (the ID gaming SERP has fewer global competitors).

### Re-computation cadence
- **Density:** weekly, after `/api/cron/tier-serp-weekly`
- **SV:** monthly, after `/api/cron/keyword-volume-refresh`
- **Intent:** on cluster entry; manually re-eval'd when keyword behaviour changes

---

## Why this formula, not Semrush KD?

Generic Keyword Difficulty scores treat "competitive" as a property of the keyword in isolation. We're a gaming/digital-goods marketplace — what's "competitive" *for us* depends on whether the keyword **monetizes**. By baking intent into the score (20% weight), we surface keywords that are both hard-to-win **and** worth winning.

---

## Tuning the weights

Defaults live in env vars; set per-workspace later if needed:

```bash
SCORE_WEIGHT_SV=0.50         # default 0.50
SCORE_WEIGHT_DENSITY=0.30    # default 0.30
SCORE_WEIGHT_INTENT=0.20     # default 0.20
```

Weights must sum to 1.0. If you change them, document the rationale in this file so the next analyst doesn't have to reverse-engineer the call.

---

## Files

- **Live page:** `/methodology/competitive-keywords`
- **This doc:** `docs/methodology-competitive-keywords.md`
- **Implementation:** (forthcoming) `src/lib/scoring/competitive-keyword.ts`
- **Inputs:** `tier_serp_snapshots.top_10`, `keyword_volume_cache`, `keyword_intent`
