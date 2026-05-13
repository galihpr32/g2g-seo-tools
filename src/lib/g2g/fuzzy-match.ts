// ─── Lightweight fuzzy matching for opportunity → product linking ──────────
// We're matching short strings (brand_name ≤ 50 chars, topic ≤ 80) so we can
// afford a simple token-overlap + edit-distance hybrid without external deps.
//
// Scoring (0..1):
//   1. Normalize both sides: lowercase, strip non-alphanumerics, collapse spaces
//   2. Token Jaccard: |intersect(tokens_a, tokens_b)| / |union(...)|
//   3. Boost +0.15 if every brand_name token appears in the topic (rare but
//      strong signal — "Genshin Impact" tokens both present in "buy genshin
//      impact account" → very likely the right product)
//   4. Floor 0, cap 1.0
//
// Threshold defaults to 0.55 — empirically separates obvious matches
// ("free fire diamonds" → "Free Fire") from noise ("how to play" → "How").

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
  'buy', 'sell', 'cheap', 'best', 'top', 'how', 'where', 'when', 'what',
  'is', 'are', 'with',
])

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))
}

export function fuzzyScore(brandName: string, opportunityTopic: string): number {
  const brand = normalize(brandName)
  const opp   = normalize(opportunityTopic)
  if (brand.length === 0 || opp.length === 0) return 0

  const brandSet = new Set(brand)
  const oppSet   = new Set(opp)
  const intersect = new Set([...brandSet].filter(t => oppSet.has(t)))
  if (intersect.size === 0) return 0

  const union   = new Set([...brandSet, ...oppSet])
  const jaccard = intersect.size / union.size

  // Containment boost: every brand token shows up in the opp string
  const containment = brand.every(t => oppSet.has(t)) ? 0.15 : 0

  return Math.min(1, jaccard + containment)
}

export interface MatchCandidate {
  relation_id: string
  brand_name:  string
  score:       number
}

/**
 * Find the best-matching catalog row(s) for a given opportunity topic.
 *
 * @param topic        — the opportunity.topic text we're trying to map
 * @param catalog      — array of {relation_id, brand_name} candidates
 * @param threshold    — minimum score to include (default 0.55)
 * @param limit        — max returned candidates (default 5; UI shows top match + alternatives)
 */
export function findMatches(
  topic:     string,
  catalog:   { relation_id: string; brand_name: string }[],
  threshold = 0.55,
  limit     = 5,
): MatchCandidate[] {
  const scored: MatchCandidate[] = []
  for (const row of catalog) {
    const s = fuzzyScore(row.brand_name, topic)
    if (s >= threshold) scored.push({ relation_id: row.relation_id, brand_name: row.brand_name, score: s })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}
