// ─── News-export enrichment helpers ────────────────────────────────────────
// Pure functions used by the row builders. No DB / network deps — easy to
// unit-test in isolation if/when we add tests.

/** Per-source authority score (1-10). Higher = more weight in importance calc. */
const SOURCE_AUTHORITY: Record<string, number> = {
  // Tier 1 — major gaming media
  'IGN':        9,
  'Polygon':    8,
  'PC Gamer':   8,
  'Eurogamer':  8,
  'Kotaku':     8,
  'Rock Paper Shotgun': 8,
  'GameSpot':   8,
  // Tier 2 — solid coverage
  'GameRant':   6,
  'Game Informer': 6,
  'Destructoid': 6,
  'PCMag':      6,
  // Default for unrecognised
  '__default__': 5,
}

export function sourceAuthority(sourceName: string | null | undefined): number {
  if (!sourceName) return SOURCE_AUTHORITY.__default__
  const exact = SOURCE_AUTHORITY[sourceName]
  if (typeof exact === 'number') return exact
  // Case-insensitive fallback
  const key = Object.keys(SOURCE_AUTHORITY).find(
    k => k.toLowerCase() === sourceName.toLowerCase()
  )
  return key ? SOURCE_AUTHORITY[key] : SOURCE_AUTHORITY.__default__
}

/**
 * Importance Score (1-100). Combines:
 *   - source authority (1-10)
 *   - mention count within article (1-N)
 *   - KB match multiplier (matched = 1.3, no match = 1.0)
 *   - recency decay (today = 1.0, 14 days old = 0.5, >30 days = 0.2)
 *
 * Formula: round( min(100, sourceAuth × 4 × mentionScale × kbMult × recencyMult) )
 */
export function importanceScore(args: {
  sourceName:   string | null
  mentionCount: number
  kbMatched:    boolean
  publishedAt:  string | null
}): number {
  const auth = sourceAuthority(args.sourceName)
  const mentionScale = Math.min(2.0, 1 + (Math.max(0, args.mentionCount - 1) * 0.25))   // 1→1.0, 2→1.25, 3→1.5, 5+→2.0
  const kbMult = args.kbMatched ? 1.3 : 1.0

  let recencyMult = 1.0
  if (args.publishedAt) {
    const days = (Date.now() - new Date(args.publishedAt).getTime()) / 86_400_000
    if      (days <= 3)  recencyMult = 1.0
    else if (days <= 7)  recencyMult = 0.85
    else if (days <= 14) recencyMult = 0.65
    else if (days <= 30) recencyMult = 0.4
    else                  recencyMult = 0.2
  }

  return Math.round(Math.min(100, auth * 4 * mentionScale * kbMult * recencyMult))
}

/** Direction arrow vs previous-period count. */
export function trendDirection(curr: number, prev: number): '↑' | '↓' | '→' {
  if (prev === 0 && curr === 0) return '→'
  if (prev === 0) return '↑'
  const ratio = curr / prev
  if (ratio >= 1.2) return '↑'
  if (ratio <= 0.8) return '↓'
  return '→'
}

/**
 * Action suggestion. Deterministic rule based on score + G2G coverage state.
 * Used by the export rows so the receiving division has actionable next-steps,
 * not just data.
 */
export function actionSuggestion(args: {
  buzzScore:        number     // 0-100
  hasG2gCoverage:   boolean    // does G2G have a product page for this game?
  daysSinceLatest:  number
}): { action: 'Pitch brief' | 'Monitor' | 'Ignore'; reason: string } {
  const { buzzScore, hasG2gCoverage, daysSinceLatest } = args
  if (daysSinceLatest > 30) {
    return { action: 'Ignore', reason: 'Stale signal (>30d since latest article)' }
  }
  if (buzzScore >= 70 && !hasG2gCoverage) {
    return { action: 'Pitch brief', reason: 'High buzz + no G2G page yet — net-new opportunity' }
  }
  if (buzzScore >= 55 && hasG2gCoverage) {
    return { action: 'Pitch brief', reason: 'High buzz on existing G2G product — refresh angle' }
  }
  if (buzzScore >= 35) {
    return { action: 'Monitor', reason: 'Mid-tier signal — watch for next-week spike' }
  }
  return { action: 'Ignore', reason: 'Low buzz score' }
}

/**
 * Compute a buzz score (1-100) for a game from its rollup metrics.
 * Different from per-article importance — this is "how hot is this game
 * across all articles in the window".
 */
export function gameBuzzScore(args: {
  articleCount:     number
  avgSourceAuth:    number      // average authority of the sources that covered it
  newsTypeBreakdown: Record<string, number>
  kbMatched:        boolean
}): number {
  // Article count is the dominant signal — but capped to prevent inflation
  // from a single source spamming.
  const countScore = Math.min(40, args.articleCount * 8)

  // Authority averaged across sources (max 30)
  const authScore = Math.min(30, args.avgSourceAuth * 3)

  // News-type diversity — releases + events score higher than just reviews
  const types = Object.keys(args.newsTypeBreakdown)
  let typeScore = 0
  if (types.includes('release')) typeScore += 8
  if (types.includes('event'))   typeScore += 6
  if (types.includes('update'))  typeScore += 4
  if (types.includes('esports')) typeScore += 4
  if (types.includes('leak'))    typeScore += 6
  if (types.includes('sale'))    typeScore += 3
  typeScore = Math.min(20, typeScore)

  // KB match bonus
  const kbScore = args.kbMatched ? 10 : 0

  return Math.min(100, Math.round(countScore + authScore + typeScore + kbScore))
}
