// ─── Tyr breakdown → action suggestion ────────────────────────────────────
//
// Specialist 1 looks at a Tyr review and has to decide MANUALLY:
//   - Override (accept as-is)
//   - Full regenerate (Bragi rebuild from scratch)
//   - Partial regenerate (rebuild only a weak section — outline / FAQ / etc.)
//   - Re-run Tyr (after writer manually fixed something)
//
// Same patterns recur across briefs ("FAQ thin", "internal links missing").
// This module classifies the breakdown into a SUGGESTION the UI can pre-fill
// — saves ~30s decision time per brief, plus reduces error rate from human
// fatigue. Specialist 1 still has final say; the suggestion is just a
// starting point.
//
// Pure rules-based — no LLM call, runs instantly client-side.

import type { TyrBreakdown } from '@/components/agents/BriefQualityReview'

export type SuggestedAction =
  | { kind: 'override';            confidence: 1 | 2 | 3; reason: string }
  | { kind: 'regenerate_full';     confidence: 1 | 2 | 3; reason: string }
  | { kind: 'regenerate_section';  section: 'outline' | 'faq' | 'meta' | 'keywords'; confidence: 1 | 2 | 3; reason: string }
  | { kind: 'rerun_tyr';           confidence: 1 | 2 | 3; reason: string }
  | { kind: 'wait';                confidence: 1 | 2 | 3; reason: string }

export interface TyrSuggestion {
  action:    SuggestedAction
  /** Top 1-3 weaknesses driving the suggestion */
  topIssues: { dimension: string; score: number; comment: string }[]
  /** Score thresholds applied (for transparency in UI) */
  threshold: { override: number; section: number; full: number }
}

const THRESHOLD = {
  override: 80,   // ≥ this → override is safe
  section:  65,   // 65-79 → partial regen / fix specific section
  full:     50,   // < 50 → full regenerate
} as const

// Map dimension → which "section" regenerate option fits
const DIMENSION_TO_SECTION: Record<string, 'outline' | 'faq' | 'meta' | 'keywords'> = {
  coverage:          'outline',
  intent_match:      'meta',
  heading_structure: 'outline',
  keyword_strategy:  'keywords',
  faq_quality:       'faq',
  meta_description:  'meta',
  internal_links:    'outline',     // outline includes internal-link plan
  eeat_signals:      'outline',     // E-E-A-T touches outline copy
  // Sprint #356 TYR.GEO.SCORE — GEO dimensions also route to a section.
  // Answer-shape, citable stats and entity naming all live in the outline
  // (H2 phrasing + body framing). FAQ quotability is naturally the FAQ.
  geo_answer_shape:    'outline',
  geo_citable_stats:   'outline',
  geo_entity_naming:   'outline',
  geo_faq_quotability: 'faq',
}

/**
 * Classify a Tyr breakdown into a suggested next action. Returns null when
 * the breakdown is too thin / legacy-shaped to act on.
 */
export function suggestTyrAction(opts: {
  score:    number | null
  status:   string | null         // 'reviewed' | 'borderline' | 'failed' | null
  breakdown: TyrBreakdown | null
}): TyrSuggestion | null {
  const { score, status, breakdown } = opts

  if (score == null && !breakdown) return null

  // Legacy breakdown shape (no `dimensions` map) — too coarse to suggest
  // partial regen. Fall back to score-only suggestion.
  if (!breakdown?.dimensions) {
    if (score == null) return null
    if (score >= THRESHOLD.override) {
      return {
        action: { kind: 'override', confidence: 3, reason: `Score ${score}/100 — meets threshold. Safe to publish.` },
        topIssues: [],
        threshold: THRESHOLD,
      }
    }
    if (score < THRESHOLD.full) {
      return {
        action: { kind: 'regenerate_full', confidence: 3, reason: `Score ${score}/100 is below floor. Full regenerate recommended.` },
        topIssues: [],
        threshold: THRESHOLD,
      }
    }
    return {
      action: { kind: 'rerun_tyr', confidence: 2, reason: `Score ${score}/100 — borderline. Manually edit weak parts then re-run Tyr.` },
      topIssues: [],
      threshold: THRESHOLD,
    }
  }

  // Rich breakdown — analyze per-dimension
  const dims = Object.entries(breakdown.dimensions ?? {}) as Array<[string, { score: number; comment: string }]>
  const sortedWeak = dims
    .filter(([, d]) => d != null)
    .sort(([, a], [, b]) => a.score - b.score)
  const topIssues = sortedWeak.slice(0, 3).map(([dim, d]) => ({
    dimension: dim,
    score: d.score,
    comment: d.comment,
  }))

  const overallScore = score ?? Math.round(
    sortedWeak.reduce((s, [, d]) => s + d.score, 0) / sortedWeak.length * 10
  )

  // Case 1: high overall — Override
  if (overallScore >= THRESHOLD.override && status !== 'failed') {
    return {
      action: { kind: 'override', confidence: 3, reason: `Score ${overallScore}/100 with no critical dimension failures. Safe.` },
      topIssues,
      threshold: THRESHOLD,
    }
  }

  // Case 2: very low overall — Full regenerate
  if (overallScore < THRESHOLD.full) {
    return {
      action: { kind: 'regenerate_full', confidence: 3, reason: `Score ${overallScore}/100 is structurally weak across multiple dimensions. Full rebuild.` },
      topIssues,
      threshold: THRESHOLD,
    }
  }

  // Case 3: middling — try partial regen IF the issue is concentrated in one section
  // Concentration = the lowest-scoring dimension is ≥3 points worse than the next
  const lowest    = sortedWeak[0]
  const nextLowest = sortedWeak[1]
  if (lowest && nextLowest) {
    const gap = nextLowest[1].score - lowest[1].score
    const isolated = gap >= 3 && lowest[1].score <= 5
    if (isolated) {
      const section = DIMENSION_TO_SECTION[lowest[0]]
      if (section) {
        return {
          action: {
            kind:       'regenerate_section',
            section,
            confidence: 2,
            reason:     `${prettyDimName(lowest[0])} is the only weak dimension (${lowest[1].score}/10). Regenerate just the ${section} section instead of the whole brief.`,
          },
          topIssues,
          threshold: THRESHOLD,
        }
      }
    }
  }

  // Case 4: middling, multiple weaknesses — rerun Tyr after manual fix
  const weakCount = sortedWeak.filter(([, d]) => d.score <= 6).length
  if (weakCount >= 3) {
    return {
      action: {
        kind:       'regenerate_full',
        confidence: 2,
        reason:     `${weakCount} dimensions scored ≤6. Multiple structural issues — full regenerate likely faster than manual fixes.`,
      },
      topIssues,
      threshold: THRESHOLD,
    }
  }

  // Case 5: 1-2 weak dimensions, score middling — suggest rerun after manual fix
  return {
    action: {
      kind:       'rerun_tyr',
      confidence: 2,
      reason:     `Score ${overallScore}/100. Top issue: ${prettyDimName(topIssues[0]?.dimension ?? 'unknown')}. Manually fix in the editor, then re-run Tyr.`,
    },
    topIssues,
    threshold: THRESHOLD,
  }
}

function prettyDimName(dim: string): string {
  return dim.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Section regenerate parameter shape — used by partial-regen endpoint ──

export type RegenSection = 'outline' | 'faq' | 'meta' | 'keywords'

export interface SectionRegenInstruction {
  section:  RegenSection
  /** Optional user notes to bias the regen */
  notes?:   string
}
