// ─── KB ↔ Catalog category mapping ──────────────────────────────────────────
// Single source of truth: knowledge_base_items (category='category') row
// names are the canonical display values everywhere in the app. This module
// converts between three label spaces:
//
//   1. KB canonical            — team-curated, granular ("Software & Apps (Account)")
//   2. Catalog service_name    — G2G CMS values from CSV ("Activation Links")
//   3. Free-text input         — what a user types or pastes ("game-keys")
//
// All three converge to KB canonical for storage in product_tiers.category.
//
// Algorithm (greedy, no LLM):
//   1. Honor explicit override (KB row.data.catalog_service_match)
//   2. Exact case-insensitive match
//   3. Token overlap: count shared word stems, ignoring stopwords
//   4. Return null if no match scores >= 1 stem
//
// Calling pattern:
//   const map = await fetchKbCategoryMap(siteSlug)
//   const kbName = mapToKbCanonical('Activation Links', map)
//   // → 'Games/Key' (if KB has that row)

export interface KbCategory {
  name:                  string
  description?:          string
  buyer_intent?:         string
  angle?:                string
  catalog_service_match: string | null
}

// ─── Tokenizer ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  '&', 'and', 'or', 'the', 'a', 'an', 'of', 'in', 'on', 'with', 'for',
  'apps', 'app', 'links',   // ambiguous filler words in our domain
])

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[/\\]/g, ' ')   // 'Games/Key' → ['games', 'key']
    .replace(/[^a-z0-9 -]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !STOPWORDS.has(t))
    .map(t => stem(t))
}

/** Tiny stemmer — strips plural 's' and gerund 'ing'. Enough for our domain. */
function stem(t: string): string {
  if (t.length > 3 && t.endsWith('ing')) return t.slice(0, -3)
  if (t.length > 3 && t.endsWith('s'))   return t.slice(0, -1)
  return t
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Map an arbitrary label (catalog service_name or free-text) to the closest
 * KB canonical name.
 *
 * @returns KB canonical name OR null if nothing scores above the threshold.
 *
 * Designed to be cheap (no LLM, no DB call). Pre-fetch the KB category list
 * once and pass it in; reuse across many calls.
 */
export function mapToKbCanonical(
  input:     string,
  kbList:    KbCategory[],
  threshold: number = 1,
): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  // 1. Explicit override (manual mapping set via KB admin)
  const explicit = kbList.find(k => k.catalog_service_match?.toLowerCase() === trimmed.toLowerCase())
  if (explicit) return explicit.name

  // 2. Exact case-insensitive match against KB name
  const exact = kbList.find(k => k.name.toLowerCase() === trimmed.toLowerCase())
  if (exact) return exact.name

  // 3. Token overlap
  const inputTokens = new Set(tokens(trimmed))
  if (inputTokens.size === 0) return null

  let best: { name: string; score: number } | null = null
  for (const kb of kbList) {
    const kbTokens = new Set(tokens(kb.name))
    let score = 0
    for (const t of inputTokens) if (kbTokens.has(t)) score++
    // Tie-break: prefer KB rows with fewer extra tokens (more specific match)
    if (score >= threshold && (!best || score > best.score)) {
      best = { name: kb.name, score }
    }
  }
  return best?.name ?? null
}

/**
 * Reverse direction: given a KB canonical, return the likely catalog
 * service_name. Used by detect-category helpers in brief generator.
 */
export function mapKbToCatalogService(
  kbName: string,
  kbList: KbCategory[],
): string | null {
  const kb = kbList.find(k => k.name === kbName)
  if (kb?.catalog_service_match) return kb.catalog_service_match

  // Fallback: token-match against the 9 known catalog values
  const CATALOG_SERVICES = [
    'Gift Cards', 'Accounts', 'Top Up', 'Items', 'Game coins',
    'Platform Engagement', 'Game Coaching', 'GamePal', 'Activation Links',
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeList: KbCategory[] = CATALOG_SERVICES.map(n => ({ name: n, catalog_service_match: null } as any))
  return mapToKbCanonical(kbName, fakeList, 1)
}
