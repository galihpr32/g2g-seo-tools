// ─── Broken URL classifier ────────────────────────────────────────────────
//
// Pure rules-based classifier — call client OR server. Categorizes a broken
// URL into one of:
//
//   high-impact-404 — 4xx + ≥1000 historical GSC impressions (urgent)
//   5xx            — server error (always urgent regardless of traffic)
//   lost-from-gsc  — used to be in index, no longer (recoverable, high prio
//                    if historical impressions ≥ 500)
//   low-impact-404 — 4xx + low historical traffic (cleanup priority)
//
// Used by /content/broken-urls UI to show a colored badge per row + suggest
// the "Create Action Item" call.

export type BrokenUrlClassification =
  | 'high-impact-404'
  | '5xx'
  | 'lost-from-gsc'
  | 'low-impact-404'

export interface ClassifyInput {
  status_code:           number | null
  historical_impressions: number
  is_lost_page?:         boolean   // true = used to rank in GSC, no longer
}

export interface ClassifyOutput {
  classification: BrokenUrlClassification
  priority:       'high' | 'medium' | 'low'
  reason:         string
}

const HIGH_IMPACT_THRESHOLD = 1000
const LOST_HIGH_THRESHOLD   = 500

export function classifyBrokenUrl(input: ClassifyInput): ClassifyOutput {
  const { status_code, historical_impressions, is_lost_page } = input

  // 5xx — always urgent
  if (status_code != null && status_code >= 500) {
    return {
      classification: '5xx',
      priority:       'high',
      reason:         `Server error (HTTP ${status_code})`,
    }
  }

  // Lost from GSC (no current 4xx but page disappeared from index)
  if (is_lost_page) {
    return {
      classification: 'lost-from-gsc',
      priority:       historical_impressions >= LOST_HIGH_THRESHOLD ? 'high' : 'medium',
      reason:         `Lost from GSC index — ${historical_impressions.toLocaleString()} historical impressions`,
    }
  }

  // 4xx — split by traffic impact
  if (status_code != null && status_code >= 400) {
    if (historical_impressions >= HIGH_IMPACT_THRESHOLD) {
      return {
        classification: 'high-impact-404',
        priority:       'high',
        reason:         `4xx (HTTP ${status_code}) on a high-traffic URL — ${historical_impressions.toLocaleString()} impressions`,
      }
    }
    return {
      classification: 'low-impact-404',
      priority:       'low',
      reason:         `4xx (HTTP ${status_code}) on a low-traffic URL`,
    }
  }

  // Fallback
  return {
    classification: 'low-impact-404',
    priority:       'low',
    reason:         'Status unknown — likely 4xx',
  }
}

export const CLASSIFICATION_STYLES: Record<BrokenUrlClassification, { label: string; class: string; emoji: string }> = {
  'high-impact-404':  { label: 'HIGH-IMPACT 404', class: 'bg-red-500/15 text-red-300 border-red-500/30',         emoji: '🚨' },
  '5xx':              { label: 'SERVER ERROR',    class: 'bg-purple-500/15 text-purple-300 border-purple-500/30', emoji: '💥' },
  'lost-from-gsc':    { label: 'LOST FROM GSC',   class: 'bg-amber-500/15 text-amber-300 border-amber-500/30',    emoji: '👻' },
  'low-impact-404':   { label: 'LOW-IMPACT 404',  class: 'bg-gray-700/40 text-gray-400 border-gray-700',           emoji: '📭' },
}
