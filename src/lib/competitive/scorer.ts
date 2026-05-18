// ── Competitive Keyword Scorer ──────────────────────────────────────────────
//
// Implements the methodology codified at /methodology/competitive-keywords:
//
//   score = (SV_norm × 0.50) + (SERP Density × 0.30) + (Intent × 0.20)
//
// Each input signal is normalized 0-100. Final score 0-100. Higher = more
// competitive = more worth chasing.
//
// Cluster definition (per Sprint COMPETITIVE.SCORER Q1 decision):
//   cluster = (product_tier_id × market)
//
// Winner rule (per Q2 decision):
//   Top 3 by competitive_score per cluster get is_cluster_winner=true with
//   cluster_rank 1/2/3. Friday KPI digest pulls this subset.

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface KeywordSignals {
  sv_volume:        number | null   // raw monthly searches (DataForSEO)
  sv_volume_norm:   number          // 0-100 within cluster
  serp_density:     number          // 0-100, computed from latest tier_serp_snapshot
  intent_score:     number          // 0-100, heuristic intent classifier
  competitive_score: number         // weighted blend
}

export interface ScoredKeyword {
  id:               string
  product_tier_id:  string
  cluster_market:   string
  keyword:          string
  signals:          KeywordSignals
}

export interface ClusterScoring {
  product_tier_id:  string
  cluster_market:   string
  kws:              ScoredKeyword[]
  /** Cluster-level summary so the discovery flow can decide "this cluster has
   *  no real winner yet" → trigger gap discovery. */
  has_top_1:        boolean
  top_score:        number
}

// ─── Intent classifier (heuristic, no LLM) ─────────────────────────────────

/**
 * Map a keyword to its commercial intent score. Anchored on Galih's methodology
 * docs: transactional=100, commercial=80, info=50, nav=30.
 *
 * Why heuristic instead of LLM: at our scale (~500 tier_keywords total) the
 * patterns are stable and the per-keyword cost of an LLM call (~$0.0001) adds
 * up across re-scoring. Heuristic catches ≥95% of real cases.
 */
export function classifyIntent(keyword: string): number {
  const kw = keyword.toLowerCase().trim()

  // Transactional patterns — strongest signal first
  // "buy X", "X for sale", "cheap X", "X price", "order X", "X top up", "topup X",
  // "X account for sale", "X gold for sale", "X cd key"
  if (/\b(buy|order|purchase|cheap|price|cost|sale|top[- ]?up|topup|redeem|cd[- ]?key|voucher|gift[- ]?card|recharge|deal)\b/.test(kw)) return 100
  if (/\bfor[- ]?sale\b/.test(kw))                                     return 100
  if (/\b(coin|gold|gem|crystal|currency|item|account|skin)s?\s+(for[- ]?sale|cheap|buy|store|shop)\b/.test(kw)) return 100

  // Commercial — comparison / decision-stage
  // "best X", "X vs Y", "X review", "top X", "X comparison", "where to buy X"
  if (/\b(best|top \d+|review|reviews|vs|versus|comparison|compare|recommend|recommendation)\b/.test(kw))     return 80
  if (/\bwhere[- ]?to[- ]?buy\b/.test(kw))                              return 80
  if (/\bsafe(st)?\b/.test(kw))                                         return 80

  // Navigational — branded queries pointing to a specific entity
  // Single-token product names ("genshin", "valorant") often nav; we lean
  // info because they could be either, but flag as nav if there's a domain hint
  if (/\b(reddit|youtube|wiki|fandom|forum|discord|twitter|instagram)\b/.test(kw)) return 30
  if (kw.split(/\s+/).length === 1 && kw.length < 12)                  return 30

  // Informational — questions, learn-stage
  // "how to X", "what is X", "X tier list", "X guide", "X tips"
  if (/^(how|what|why|when|where|which|who)\s/.test(kw))                return 50
  if (/\b(guide|tutorial|tips|tricks|walkthrough|tier[- ]?list|wiki|build|meta|leaderboard)\b/.test(kw)) return 50
  if (/\b(news|update|release|patch|event|leak|leaks)\b/.test(kw))      return 50

  // Default: lean info (50) — safer to under-score nav than over-score commercial
  return 50
}

// ─── SERP density from top-10 ──────────────────────────────────────────────

interface TopResult {
  position: number
  url:      string
  domain:   string
  title?:   string
}

/**
 * SERP Density 0-100. Higher = more contested = "genuinely competitive".
 *
 * Approach:
 *   • Count DISTINCT non-our-domain entries in top 10
 *   • Weight strong known competitors higher (G2A, Eneba, Kinguin, IGGM, etc.)
 *
 * Why distinct count vs raw position: a SERP dominated by 10 different big
 * brands is more contested than a SERP where one brand owns 7 positions
 * (subdomains/categories of same brand = effectively monopoly).
 */
const KNOWN_COMPETITOR_BRANDS = new Set([
  // Tier 1 competitors (digital goods marketplaces)
  'g2a.com', 'eneba.com', 'kinguin.net', 'iggm.com', 'mmoga.com',
  'codashop.com', 'razergold.com', 'mtcgame.com', 'gamerall.com',
  'playerauctions.com', 'mmogah.com', 'gameflip.com', 'mogs.com',
  // Authority sites that monopolize info-leaning kws
  'reddit.com', 'youtube.com', 'wikipedia.org', 'fandom.com',
  // Local PH/ID competitors
  'tokopedia.com', 'shopee.co.id', 'bukalapak.com', 'blibli.com',
])

export function computeSerpDensity(
  top10:    TopResult[] | null | undefined,
  ourDomain: string,
): number {
  if (!Array.isArray(top10) || top10.length === 0) return 0

  const ours = ourDomain.toLowerCase().replace(/^www\./, '')
  const seen = new Set<string>()
  let strongCount = 0

  for (const r of top10) {
    const d = String(r.domain ?? '').toLowerCase().replace(/^www\./, '')
    if (!d || d === ours) continue
    if (seen.has(d)) continue
    seen.add(d)
    if (KNOWN_COMPETITOR_BRANDS.has(d)) strongCount += 1
  }

  // Base: distinct competitor count × 10 (so 10 distinct = 100)
  // Bonus: each strong known brand adds +5 (capped at 100)
  const base   = Math.min(100, seen.size * 10)
  const bonus  = strongCount * 5
  return Math.min(100, base + bonus)
}

// ─── SV normalization (per cluster) ─────────────────────────────────────────

/**
 * Given a list of raw SV numbers within ONE cluster, return per-kw normalized
 * values 0-100. Max SV in the cluster = 100; others scale proportionally
 * (linear).
 *
 * Null SV = 0 (no data; can't claim demand exists).
 */
export function normalizeSvWithinCluster(svValues: Array<number | null>): number[] {
  const maxSv = Math.max(...svValues.map(v => v ?? 0), 1)
  return svValues.map(v => v == null ? 0 : Math.round((v / maxSv) * 100))
}

// ─── The formula ────────────────────────────────────────────────────────────

export function blendScore(s: {
  sv_volume_norm: number
  serp_density:   number
  intent_score:   number
}): number {
  // Methodology weights from /methodology/competitive-keywords
  const v = Math.max(0, Math.min(100, s.sv_volume_norm))
  const d = Math.max(0, Math.min(100, s.serp_density))
  const i = Math.max(0, Math.min(100, s.intent_score))
  return Math.round(v * 0.50 + d * 0.30 + i * 0.20)
}

// ─── Score a full cluster ──────────────────────────────────────────────────

export interface ScoreClusterInput {
  product_tier_id: string
  cluster_market:  string
  /** Our site domain — used to exclude self from density count. */
  our_domain:      string
  keywords: Array<{
    id:        string
    keyword:   string
    sv_volume: number | null
    top10:     TopResult[] | null
  }>
}

/**
 * Score one cluster end-to-end. Returns scored kws sorted desc + cluster meta.
 * Caller is responsible for persisting back to tier_keywords.
 */
export function scoreCluster(input: ScoreClusterInput): ClusterScoring {
  const svValues = input.keywords.map(k => k.sv_volume)
  const svNorms  = normalizeSvWithinCluster(svValues)

  const scored: ScoredKeyword[] = input.keywords.map((k, idx) => {
    const sv_volume_norm = svNorms[idx]
    const serp_density   = computeSerpDensity(k.top10, input.our_domain)
    const intent_score   = classifyIntent(k.keyword)
    const competitive_score = blendScore({ sv_volume_norm, serp_density, intent_score })
    return {
      id:              k.id,
      product_tier_id: input.product_tier_id,
      cluster_market:  input.cluster_market,
      keyword:         k.keyword,
      signals: {
        sv_volume:        k.sv_volume,
        sv_volume_norm,
        serp_density,
        intent_score,
        competitive_score,
      },
    }
  })

  scored.sort((a, b) => b.signals.competitive_score - a.signals.competitive_score)

  return {
    product_tier_id: input.product_tier_id,
    cluster_market:  input.cluster_market,
    kws:             scored,
    has_top_1:       scored.length > 0 && scored[0].signals.competitive_score >= 60,
    top_score:       scored[0]?.signals.competitive_score ?? 0,
  }
}

// ─── Persistence helper ────────────────────────────────────────────────────

/**
 * Write scored cluster back to tier_keywords. Marks top 3 as winners with
 * cluster_rank 1/2/3. Older winners outside top 3 get unflagged.
 */
export async function persistClusterScoring(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  cluster: ClusterScoring,
): Promise<{ updated: number; error?: string }> {
  const nowIso = new Date().toISOString()

  // Update each kw with its score; assign cluster_rank to top 3
  let updated = 0
  for (let i = 0; i < cluster.kws.length; i++) {
    const k = cluster.kws[i]
    const rank = i < 3 ? i + 1 : null
    const { error } = await db
      .from('tier_keywords')
      .update({
        sv_volume:         k.signals.sv_volume,
        sv_volume_norm:    k.signals.sv_volume_norm,
        serp_density:      k.signals.serp_density,
        intent_score:      k.signals.intent_score,
        competitive_score: k.signals.competitive_score,
        cluster_market:    k.cluster_market,
        is_cluster_winner: rank !== null,
        cluster_rank:      rank,
        last_scored_at:    nowIso,
      })
      .eq('id', k.id)
      .eq('owner_user_id', ownerId)
    if (error) {
      console.warn(`[competitive-scorer] update failed for kw ${k.id}: ${error.message}`)
    } else {
      updated++
    }
  }
  return { updated }
}
