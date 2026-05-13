/**
 * Pure-function priority decomposition for seo_opportunities rows.
 *
 * The list ordering on /command-center/opportunities sorts by an implicit
 * priority — combining signal volume, total search volume, and freshness.
 * This lib makes the formula explicit + auditable so users can see WHY
 * a row sits where it does.
 *
 * Score is 0-100 (clamped). Each component contributes a weighted sub-score:
 *   - signals       (40% max) — multi-agent corroboration; more signals = higher
 *   - search_volume (35% max) — log-scaled because volume distribution is heavy-tailed
 *   - freshness     (15% max) — last_signal_at within 7d gets full credit, decays linearly
 *   - urgency       (10% max) — Heimdall click-drop adds urgency boost
 *
 * The breakdown can be displayed inline so Specialist 1 understands why
 * "Mobile Legends Diamonds" outranks "wow shadowlands gold" even when
 * total_sv is similar.
 */

export interface PriorityComponent {
  key:      'signals' | 'search_volume' | 'freshness' | 'urgency'
  label:    string
  raw:      number
  max:      number
  weight:   number   // 0..1
  score:    number   // raw / max * weight * 100
  reason:   string
}

export interface OpportunityPrioritySnapshot {
  signal_count:    number
  total_sv:        number
  last_signal_at:  string | null
  heimdall_signals?: Array<{ clicks_drop?: number }> | null
}

export interface PriorityBreakdown {
  score:      number               // total 0..100
  components: PriorityComponent[]
  topReason:  string               // the dominant component as a one-liner
}

const WEIGHTS = {
  signals:        0.40,
  search_volume:  0.35,
  freshness:      0.15,
  urgency:        0.10,
}

export function computeOpportunityPriority(opp: OpportunityPrioritySnapshot): PriorityBreakdown {
  // ── signals — full credit at 5+ signals (3 agents × ~2 each) ─────────────
  const signalRaw   = Math.min(opp.signal_count, 5)
  const signalScore = (signalRaw / 5) * WEIGHTS.signals * 100

  // ── search_volume — log-scaled. 100k SV ≈ full credit ────────────────────
  const sv = Math.max(0, opp.total_sv)
  const svRaw   = Math.log10(sv + 1) / Math.log10(100_001)   // 0..1
  const svScore = svRaw * WEIGHTS.search_volume * 100

  // ── freshness — full credit ≤7d, zero credit ≥30d, linear in between ─────
  let freshnessRaw = 0
  if (opp.last_signal_at) {
    const ageDays = (Date.now() - new Date(opp.last_signal_at).getTime()) / 86_400_000
    if (ageDays <= 7) freshnessRaw = 1
    else if (ageDays >= 30) freshnessRaw = 0
    else freshnessRaw = 1 - ((ageDays - 7) / 23)
  }
  const freshnessScore = freshnessRaw * WEIGHTS.freshness * 100

  // ── urgency — sum of Heimdall click-drops, capped at 500 daily clicks lost
  const totalDrop = (opp.heimdall_signals ?? []).reduce(
    (s, sig) => s + Math.max(0, sig?.clicks_drop ?? 0),
    0,
  )
  const urgencyRaw = Math.min(totalDrop, 500) / 500
  const urgencyScore = urgencyRaw * WEIGHTS.urgency * 100

  const components: PriorityComponent[] = [
    {
      key:    'signals',
      label:  'Multi-agent corroboration',
      raw:    opp.signal_count,
      max:    5,
      weight: WEIGHTS.signals,
      score:  signalScore,
      reason: opp.signal_count >= 3
        ? `${opp.signal_count} signals — strong corroboration across agents`
        : `${opp.signal_count} signal${opp.signal_count === 1 ? '' : 's'} — light corroboration`,
    },
    {
      key:    'search_volume',
      label:  'Search volume',
      raw:    sv,
      max:    100_000,
      weight: WEIGHTS.search_volume,
      score:  svScore,
      reason: sv >= 10_000
        ? `${sv.toLocaleString()} SV — high traffic potential`
        : sv >= 1_000
          ? `${sv.toLocaleString()} SV — moderate traffic potential`
          : `${sv.toLocaleString()} SV — low traffic potential`,
    },
    {
      key:    'freshness',
      label:  'Freshness',
      raw:    freshnessRaw,
      max:    1,
      weight: WEIGHTS.freshness,
      score:  freshnessScore,
      reason: !opp.last_signal_at
        ? 'No signal date — treated as stale'
        : freshnessRaw === 1
          ? 'Fresh — last signal within 7d'
          : freshnessRaw === 0
            ? 'Stale — last signal >30d'
            : 'Aging — last signal 7-30d',
    },
    {
      key:    'urgency',
      label:  'Click-drop urgency',
      raw:    totalDrop,
      max:    500,
      weight: WEIGHTS.urgency,
      score:  urgencyScore,
      reason: totalDrop > 100
        ? `${totalDrop} clicks lost — high urgency`
        : totalDrop > 0
          ? `${totalDrop} clicks lost — minor urgency`
          : 'No click-drop signal',
    },
  ]

  const total = components.reduce((s, c) => s + c.score, 0)
  const topComponent = [...components].sort((a, b) => b.score - a.score)[0]

  return {
    score:     Math.round(Math.min(100, Math.max(0, total))),
    components,
    topReason: topComponent.reason,
  }
}
