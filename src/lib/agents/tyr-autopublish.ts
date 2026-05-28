// ─── Tyr auto-publish decision engine ───────────────────────────────────────
// Called after Tyr finishes scoring a brief. Looks up the per-tier config,
// applies threshold rules, and returns the next status.
//
// Status decision matrix:
//   - auto_publish_enabled = false                 → 'needs_review' (no auto-pub for this tier)
//   - tyr_score   < min_tyr_score                  → 'needs_review'
//   - any dim    < min_dimension_threshold         → 'needs_review'
//   - violations > forbidden_violations_max        → 'needs_review'
//   - all pass                                     → 'auto_approved'
//
// Caller persists the returned status + rationale.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface TyrScore {
  overall:       number                        // 0-100
  dimensions?:   Record<string, number>        // each 0-10
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feedback?:     Record<string, any>           // freeform
}

export interface AutoPublishDecision {
  status:        'auto_approved' | 'needs_review'
  rationale:     string
  config_id:     string | null
  tier_level:    0 | 1 | 2
  thresholds:    { min_score: number; min_dim: number; max_violations: number } | null
}

/**
 * Decide whether a brief auto-publishes or needs human review.
 *
 * @param tierLevel — derived from the brief's product (0 if non-tier).
 *                    For now, the caller resolves this from
 *                    seo_action_items → product_tiers join. Pass 0 for
 *                    non-tier briefs (blog posts, generic landing pages).
 */
export async function decideAutoPublish(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:                SupabaseClient<any, any, any>,
  ownerId:           string,
  siteSlug:          string,
  tierLevel:         0 | 1 | 2,
  tyrScore:          TyrScore,
  forbiddenViolations: number = 0,
): Promise<AutoPublishDecision> {
  // 1. Pull config
  const { data: cfg } = await db
    .from('tyr_autopublish_config')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('tier_level', tierLevel)
    .maybeSingle()

  if (!cfg || !cfg.auto_publish_enabled) {
    return {
      status:    'needs_review',
      rationale: cfg ? `Auto-publish disabled for tier ${tierLevel}` : `No autopublish config for tier ${tierLevel} — default to manual review`,
      config_id: cfg?.id ?? null,
      tier_level: tierLevel,
      thresholds: null,
    }
  }

  const thresholds = {
    min_score:      Number(cfg.min_tyr_score),
    min_dim:        Number(cfg.min_dimension_threshold),
    max_violations: Number(cfg.forbidden_violations_max),
  }

  // 2. Score check
  if (tyrScore.overall < thresholds.min_score) {
    return {
      status:     'needs_review',
      rationale:  `Tyr score ${tyrScore.overall} below threshold ${thresholds.min_score} for tier ${tierLevel}`,
      config_id:  cfg.id,
      tier_level: tierLevel,
      thresholds,
    }
  }

  // 3. Dimension check
  if (tyrScore.dimensions) {
    for (const [dim, val] of Object.entries(tyrScore.dimensions)) {
      if (typeof val === 'number' && val < thresholds.min_dim) {
        return {
          status:     'needs_review',
          rationale:  `Dimension "${dim}" scored ${val} below threshold ${thresholds.min_dim}`,
          config_id:  cfg.id,
          tier_level: tierLevel,
          thresholds,
        }
      }
    }
  }

  // 4. Forbidden-claim violations check
  if (forbiddenViolations > thresholds.max_violations) {
    return {
      status:     'needs_review',
      rationale:  `${forbiddenViolations} forbidden-claim violations (max allowed: ${thresholds.max_violations})`,
      config_id:  cfg.id,
      tier_level: tierLevel,
      thresholds,
    }
  }

  // 5. All checks pass
  return {
    status:     'auto_approved',
    rationale:  `Passed all thresholds: score ${tyrScore.overall}≥${thresholds.min_score}, dims OK, violations ${forbiddenViolations}≤${thresholds.max_violations}`,
    config_id:  cfg.id,
    tier_level: tierLevel,
    thresholds,
  }
}

/**
 * Resolve tier_level for a brief by joining via action_item → product_tiers.
 * Returns 0 (non-tier) when no match.
 */
export async function resolveTierLevelForBrief(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  briefId:  string,
): Promise<0 | 1 | 2> {
  // brief → action_item → page → match against product_tiers.url or
  // product_tiers.product_name (loose match)
  const { data: brief } = await db
    .from('seo_content_briefs')
    .select('page, primary_keyword')
    .eq('id', briefId)
    .maybeSingle()
  if (!brief) return 0

  const candidates: string[] = [
    String(brief.page ?? ''),
    String(brief.primary_keyword ?? ''),
  ].filter(Boolean)
  if (candidates.length === 0) return 0

  // Match by URL exactness first (cheap), then by product_name token in keyword
  const { data: tiers } = await db
    .from('product_tiers')
    .select('tier, product_name, url')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (tiers ?? []) as any[]

  // URL exact match
  for (const t of list) {
    if (t.url && candidates.some(c => c.includes(t.url))) {
      return Number(t.tier) as 1 | 2
    }
  }

  // Product name token match on primary keyword
  const kw = candidates.join(' ').toLowerCase()
  for (const t of list) {
    const name = String(t.product_name ?? '').toLowerCase()
    if (name && kw.includes(name)) {
      return Number(t.tier) as 1 | 2
    }
  }

  return 0
}
