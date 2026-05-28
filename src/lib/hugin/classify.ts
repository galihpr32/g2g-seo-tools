// ─── Hugin long-tail classifier ──────────────────────────────────────────────
//
// Decides whether a GSC query qualifies as "long-tail discovery candidate".
//
// Three signals (a query qualifies if it passes word count OR phrase pattern):
//   1. Word count ≥ threshold (default 4)
//   2. Phrase intent pattern (question/buying/comparison) — captured even at
//      <4 words, EXCEPT when the leading words are part of a known product
//      name (e.g. "Where Winds Meet" — the game). For these we skip phrase
//      detection so we don't false-positive on game titles.
//   3. Not a brand query (auto-excluded: g2g, offgamers, g2g.com, etc.)
//
// Pure functions, no I/O. Caller builds the productStopList once per cron
// run by querying g2g_products + product_tiers names.

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Phrase patterns ───────────────────────────────────────────────────────

/** Question intent — typically starts the query. */
const QUESTION_PATTERN =
  /^(how|what|why|when|where|which|who|can|does|do|is|are|will|should)\b/i

/** Buying / commercial intent — anywhere in the query. */
const BUYING_PATTERN =
  /\b(best|safest?|cheap|cheapest|legit|trusted|reliable|review|reviews|comparison|compare|vs|versus|recommend|recommended|recommendation)\b/i

/** Generic "for {something}" pattern, often signals long-tail. */
const FOR_PATTERN = /\bfor\s+(?:my|the|a|an)?\s*\w+/i

// ─── Brand query exclusion ─────────────────────────────────────────────────

/**
 * Brand tokens we always exclude from Hugin discovery. Lowercase substrings
 * matched against the query text. Galih asked for g2g + offgamers + variations.
 */
const BRAND_TOKENS = [
  'g2g.com',
  'offgamers.com',
  ' g2g ',
  ' offgamers ',
]

export function isBrandQuery(queryLower: string): boolean {
  const padded = ` ${queryLower.trim()} `
  return BRAND_TOKENS.some(t => padded.includes(t))
    // Edge cases: query is JUST the brand word
    || queryLower.trim() === 'g2g'
    || queryLower.trim() === 'offgamers'
}

// ─── Product-name stop list ────────────────────────────────────────────────

/**
 * Build a sorted-by-length-desc list of known product names. Used to detect
 * when a query starts with a product name (so we can skip phrase intent
 * detection on those leading words).
 *
 * Pulls from both g2g_products.service_name (canonical catalog) and
 * product_tiers.product_name (active monitored products). Deduped + lowercased.
 *
 * Sorted longest-first so "where winds meet account" matches "where winds
 * meet" before falling through to a shorter "where winds" partial.
 */
export async function buildProductStopList(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
): Promise<string[]> {
  const names = new Set<string>()

  // Catalog products (entire catalog — broader coverage than just tier list)
  const { data: catalog } = await db
    .from('g2g_products')
    .select('service_name')
    .eq('owner_user_id', ownerId)
    .limit(5000)
  for (const row of (catalog ?? []) as Array<{ service_name: string | null }>) {
    if (row.service_name) names.add(String(row.service_name).toLowerCase().trim())
  }

  // Tier products (some may not be in catalog yet)
  const { data: tiers } = await db
    .from('product_tiers')
    .select('product_name')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
  for (const row of (tiers ?? []) as Array<{ product_name: string | null }>) {
    if (row.product_name) names.add(String(row.product_name).toLowerCase().trim())
  }

  // Drop empties + sort by length desc (longest match first)
  return Array.from(names).filter(Boolean).sort((a, b) => b.length - a.length)
}

/**
 * Returns true if the query starts with any product name from the stop list.
 * Match is at word-boundary: "where winds meet" matches "where winds meet account"
 * but "where windsmeet" doesn't match "where winds" partial.
 */
export function startsWithProductName(queryLower: string, productStopList: string[]): boolean {
  const q = queryLower.trim()
  for (const name of productStopList) {
    if (!name) continue
    if (q === name) return true
    if (q.startsWith(name + ' ')) return true
  }
  return false
}

// ─── Word count ─────────────────────────────────────────────────────────────

export function wordCount(query: string): number {
  return query.trim().split(/\s+/).filter(Boolean).length
}

// ─── Main classifier ────────────────────────────────────────────────────────

export interface ClassifyOptions {
  /** Word count threshold (default 4). */
  minWords?: number
  /** Whether to also accept phrase patterns at <minWords (default true). */
  includePhrasePatterns?: boolean
  /** Product name stop list, built via buildProductStopList. */
  productStopList?: string[]
}

export interface ClassifyResult {
  qualifies:                  boolean
  word_count:                 number
  is_brand_query:             boolean
  matched_by_word_count:      boolean
  matched_by_phrase_pattern:  boolean
  /** Why we did/didn't classify, useful for debug. */
  reason:                     string
}

/**
 * Decide if a query is a Hugin discovery candidate.
 *
 * Flow:
 *   1. Reject brand queries unconditionally
 *   2. If word_count >= minWords → qualifies on word count
 *   3. Else, if phrase patterns enabled:
 *      - Check if query starts with a known product name → skip phrase check
 *      - Else, check question/buying/for patterns → qualifies on phrase
 *   4. Otherwise → does not qualify
 */
export function classifyQuery(query: string, opts: ClassifyOptions = {}): ClassifyResult {
  const minWords              = opts.minWords ?? 4
  const includePhrasePatterns = opts.includePhrasePatterns !== false
  const productStopList       = opts.productStopList ?? []

  const trimmed   = String(query ?? '').trim()
  const lower     = trimmed.toLowerCase()
  const wc        = wordCount(trimmed)
  const isBrand   = isBrandQuery(lower)

  if (!trimmed) {
    return { qualifies: false, word_count: 0, is_brand_query: false, matched_by_word_count: false, matched_by_phrase_pattern: false, reason: 'empty query' }
  }
  if (isBrand) {
    return { qualifies: false, word_count: wc, is_brand_query: true, matched_by_word_count: false, matched_by_phrase_pattern: false, reason: 'brand query (excluded)' }
  }

  if (wc >= minWords) {
    return { qualifies: true, word_count: wc, is_brand_query: false, matched_by_word_count: true, matched_by_phrase_pattern: false, reason: `word_count ${wc} ≥ ${minWords}` }
  }

  if (includePhrasePatterns) {
    const startsWithProduct = startsWithProductName(lower, productStopList)

    // Buying/comparison/for patterns work anywhere in query and aren't subject
    // to the product-name prefix exemption (a query "best where winds meet
    // account" would still match "best"). Only question pattern is at start.
    const matchesQuestion = !startsWithProduct && QUESTION_PATTERN.test(lower)
    const matchesBuying   = BUYING_PATTERN.test(lower)
    const matchesFor      = FOR_PATTERN.test(lower)

    if (matchesQuestion || matchesBuying || matchesFor) {
      const which = matchesQuestion ? 'question' : matchesBuying ? 'buying' : 'for'
      return {
        qualifies:                 true,
        word_count:                wc,
        is_brand_query:            false,
        matched_by_word_count:     false,
        matched_by_phrase_pattern: true,
        reason:                    `phrase pattern (${which})`,
      }
    }

    if (startsWithProduct && QUESTION_PATTERN.test(lower)) {
      return {
        qualifies:                 false,
        word_count:                wc,
        is_brand_query:            false,
        matched_by_word_count:     false,
        matched_by_phrase_pattern: false,
        reason:                    'leading words match product name (skipped intent)',
      }
    }
  }

  return { qualifies: false, word_count: wc, is_brand_query: false, matched_by_word_count: false, matched_by_phrase_pattern: false, reason: `word_count ${wc} < ${minWords}, no phrase match` }
}
