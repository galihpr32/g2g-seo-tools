// ── Discovery → Claim helpers ────────────────────────────────────────────────
//
// Sprint PP.DISCOVERY.CLAIM.1 — heuristics used by the Discovery section on
// /priority-products/rankings?source=gsc-discovery when the user claims an
// UNTRACKED query into tier_keywords.
//
// Two heuristics, no LLM:
//   • detectBrandSearch  — is this query likely a brand search (e.g. "g2g")?
//                          We flag these so the user doesn't accidentally
//                          claim "g2g" as a product keyword.
//   • detectLanguage     — is this query likely Indonesian or English?
//                          Used to pre-select the language dropdown.

// ─── Brand search detection ───────────────────────────────────────────────────

/**
 * Common brand surface variants we know about. Add new ones as needed.
 * Lowercased + stripped of TLD for matching.
 */
const KNOWN_BRAND_TOKENS = new Set([
  'g2g', 'offgamers', 'g2gmail', 'og',
])

/**
 * Returns true if the query looks like a brand search (typing the storefront
 * name itself, not a product keyword).
 *
 * Logic:
 *   1. Exact match against KNOWN_BRAND_TOKENS
 *   2. Site brand name appears verbatim AND the query has ≤ 2 tokens
 *   3. The query IS the site domain root (with or without ".com")
 *
 * Examples:
 *   "g2g"               → true
 *   "g2g.com"           → true
 *   "g2g valorant"      → true  (brand + product, still brand-led)
 *   "valorant g2g"      → true  (same)
 *   "valorant points"   → false (no brand surface)
 *   "offgamers"         → true
 */
export function detectBrandSearch(query: string, siteSlug: string): boolean {
  const q = query.toLowerCase().trim()
  if (!q) return false

  const brandRoot = siteSlug.toLowerCase()
  const tokens    = q.split(/\s+/)

  // Exact known brand tokens
  if (KNOWN_BRAND_TOKENS.has(q)) return true

  // Domain-style matches: "g2g", "g2g.com", "www.g2g.com"
  if (q === brandRoot || q === `${brandRoot}.com` || q === `www.${brandRoot}.com`) return true

  // Brand + 1 word — typically "g2g valorant" style nav queries
  if (tokens.length <= 2 && tokens.some(t => t === brandRoot || KNOWN_BRAND_TOKENS.has(t))) {
    return true
  }

  return false
}

// ─── Language detection (id vs en) ─────────────────────────────────────────────

/**
 * Indonesian-specific tokens that don't appear in English equivalents.
 * Kept tight to avoid false positives on English phrases that happen to
 * contain words like "or" or "via".
 */
const ID_INDICATORS = new Set([
  // Verbs / common words
  'beli',     'jual',      'cara',     'gimana',  'bagaimana', 'kenapa',  'apa',
  'kapan',    'dimana',    'siapa',    'yang',    'untuk',     'dengan',  'sama',
  'agar',     'biar',      'punya',    'pakai',   'tanpa',     'bisa',    'mau',
  // Money / shopping
  'murah',    'mahal',     'harga',    'gratis',  'diskon',    'promo',   'voucher',
  'topup',    'top-up',    'isi',      'pulsa',   'paket',     'kuota',
  // Account / game-specific
  'akun',     'akunnya',   'kode',     'cek',     'lewat',     'situs',   'aplikasi',
  // Localization
  'indonesia','indo',      'gopay',    'ovo',     'dana',      'shopeepay','bca',
  'mandiri',  'permata',   'qris',     'idr',     'rp',        'rupiah',
])

/**
 * Auto-detect language of a keyword query. Returns 'id' if any Indonesian
 * indicator token is present, otherwise 'en'.
 *
 * Bias: when ambiguous, prefer 'en' since most of our tracked keywords are
 * English and DataForSEO defaults to US. False negatives ('id' typed as 'en')
 * are correctable via the dropdown.
 */
export function detectLanguage(query: string): 'en' | 'id' {
  const q = query.toLowerCase().trim()
  if (!q) return 'en'
  const tokens = q.split(/[\s\-_,.]+/)
  for (const t of tokens) {
    if (ID_INDICATORS.has(t)) return 'id'
  }
  return 'en'
}
