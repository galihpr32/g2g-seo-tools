// ─── Per-tier Anthropic model selection ─────────────────────────────────
// Sprint BRAGI.MODEL.TIER — pick the right model based on product tier so we
// don't pay Opus rates for T0/T2 briefs.
//
// Cost per article (approximation):
//   • Opus 4    — $0.30–0.45  · used for T1 (strategic, human-reviewed)
//   • Sonnet 4  — $0.08–0.12  · used for T2 + T0 (auto-publish path)
//   • Haiku 4.5 — $0.02–0.03  · used for translation (mechanical)
//
// Override per-tier via env vars without touching code:
//   BRAGI_MODEL_T1, BRAGI_MODEL_T2, BRAGI_MODEL_T0, BRAGI_MODEL_TRANSLATION,
//   TYR_MODEL

import type { SupabaseClient } from '@supabase/supabase-js'

export const BRAGI_MODEL_T1          = process.env.BRAGI_MODEL_T1          ?? 'claude-opus-4-6'
export const BRAGI_MODEL_T2          = process.env.BRAGI_MODEL_T2          ?? 'claude-sonnet-4-6'
export const BRAGI_MODEL_T0          = process.env.BRAGI_MODEL_T0          ?? 'claude-sonnet-4-6'
export const BRAGI_MODEL_TRANSLATION = process.env.BRAGI_MODEL_TRANSLATION ?? 'claude-haiku-4-5-20251001'
export const TYR_MODEL               = process.env.TYR_MODEL               ?? 'claude-sonnet-4-6'

export type TierLevel = 0 | 1 | 2

export function pickBragiModel(tier: TierLevel): string {
  switch (tier) {
    case 1:  return BRAGI_MODEL_T1
    case 2:  return BRAGI_MODEL_T2
    default: return BRAGI_MODEL_T0
  }
}

/**
 * Resolve the product tier for a brief by matching the page URL against
 * product_tiers.url. Returns 0 (non-tier) if no match found.
 *
 * Fast lookup — single SQL query. Cache to memo if called repeatedly.
 */
export async function resolveTierForPage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  page:     string | null | undefined,
  siteSlug: string | null = null,
): Promise<TierLevel> {
  if (!page) return 0
  try {
    // Exact URL match
    let q = db
      .from('product_tiers')
      .select('tier')
      .eq('url', page)
      .limit(1)
    if (siteSlug) q = q.eq('site_slug', siteSlug)
    const { data } = await q.maybeSingle()
    const tier = Number(data?.tier ?? 0)
    if (tier === 1 || tier === 2) return tier as TierLevel
  } catch { /* swallow */ }
  return 0
}

/** Estimate $ cost for a single brief generation by model. Used for budget alerting. */
export function estimateBriefCost(model: string, inTokens: number, outTokens: number): number {
  // Anthropic public pricing as of May 2026 (per million tokens):
  //   Opus 4:    $15 input / $75 output
  //   Sonnet 4:  $3  input / $15 output
  //   Haiku 4.5: $1  input / $5  output
  const rates = model.includes('opus')       ? { in: 15, out: 75 }
              : model.includes('sonnet')     ? { in: 3,  out: 15 }
              : model.includes('haiku')      ? { in: 1,  out: 5  }
              : { in: 3, out: 15 }   // sensible default
  return (inTokens * rates.in + outTokens * rates.out) / 1_000_000
}
