// ─── Forseti complaint classifier + severity scorer ────────────────────────
//
// Two pure functions used by both the scraper (auto-classify on insert) and
// the manual override path (UI Reset-to-auto button re-runs them).
//
// Why heuristic instead of LLM: at our volume (~50-200 threads/day across all
// configs), regex catches ≥95% of patterns. LLM cost adds up + introduces
// drift; the team can manually override the 5% miss. Same call we made for
// the Mimir intent classifier in scorer.ts.

// ─── Categories ─────────────────────────────────────────────────────────────
export const COMPLAINT_CATEGORIES = [
  'refund',
  'scam',
  'account_banned',
  'delivery',
  'payment',
  'customer_service',
  'fake_listing',
  'competitor_mention',
  'other',
] as const

export type ComplaintCategory = typeof COMPLAINT_CATEGORIES[number]

/**
 * Map a thread title + body to a complaint category. Order matters: stronger
 * signals checked first. "scam" beats "refund" because a scam complaint
 * usually also mentions wanting a refund — and scam is the higher-severity
 * framing.
 */
export function classifyComplaintCategory(title: string, body: string): ComplaintCategory {
  const text = `${title} ${body}`.toLowerCase()

  // Scam / fraud — highest-severity framing. Check first.
  if (/\b(scam|scammed|scammer|fraud|fraudulent|stolen|theft|cheated)\b/.test(text)) return 'scam'

  // Account-related — banned, suspended, locked, hacked.
  if (/\b(banned|suspended|locked|terminated|disabled|hacked|compromised)\s+(my\s+)?account\b/.test(text)) return 'account_banned'
  if (/\b(account\s+(?:banned|suspended|locked|terminated))\b/.test(text)) return 'account_banned'

  // Refund / chargeback.
  if (/\b(refund|money\s+back|chargeback|reimbursement|return\s+my\s+money|balikin)\b/.test(text)) return 'refund'

  // Delivery / undelivered goods.
  if (/\b(never\s+received|not\s+received|didn'?t\s+receive|undelivered|not\s+delivered|where\s+is\s+my|still\s+waiting)\b/.test(text)) return 'delivery'
  if (/\b(delivery|delay|delayed)\b/.test(text) && /\b(g2g|order|purchase)\b/.test(text)) return 'delivery'

  // Payment / billing.
  if (/\b(payment\s+failed|declined|double[- ]charged|billed\s+twice|unauthorized\s+charge|card\s+charged)\b/.test(text)) return 'payment'

  // Fake / wrong listing.
  if (/\b(fake|wrong\s+item|different\s+item|misleading|false\s+advertising)\b/.test(text)) return 'fake_listing'

  // Competitor mention — useful as positioning intel even if not a complaint.
  if (/\b(g2a|eneba|kinguin|playerauctions|iggm|mmoga|codashop)\b/.test(text)) return 'competitor_mention'

  // Customer service — last because many other complaints also mention CS.
  if (/\b(no\s+response|ignored|customer\s+service|support\s+ticket|live\s+chat|no\s+reply)\b/.test(text)) return 'customer_service'

  return 'other'
}

// ─── Severity ──────────────────────────────────────────────────────────────

export interface SeverityInput {
  upvotes:        number
  comment_count:  number
  title:          string
  body:           string
  /** Per-config preset. Defaults to small_sub. */
  preset?:        'small_sub' | 'big_sub' | 'custom'
  /** Custom thresholds; only used when preset='custom'. */
  custom?: {
    sev5_min_upvotes?:  number | null
    sev4_min_upvotes?:  number | null
    sev5_min_comments?: number | null
    sev4_min_comments?: number | null
  }
}

/**
 * Compute severity 1-5. Higher = more attention needed.
 *
 * Threshold defaults:
 *   small_sub (default, for dedicated complaint subs like r/G2G_com):
 *     sev 5 if upvotes ≥ 20 OR comments ≥ 15
 *     sev 4 if upvotes ≥ 10 OR comments ≥ 8
 *   big_sub (for general subs like r/MMORPG where complaint signal is rarer):
 *     sev 5 if upvotes ≥ 50 OR comments ≥ 30
 *     sev 4 if upvotes ≥ 25 OR comments ≥ 15
 *
 * Keyword floor: any scam/stolen/fraud/PSA/warning word → minimum sev 3
 * regardless of engagement (these need a response even if upvotes are low).
 *
 * Default for non-complaint, low-engagement = sev 2.
 * Sev 1 reserved for very-low-engagement question posts (no negative kw).
 */
export function scoreSeverity(input: SeverityInput): number {
  const preset = input.preset ?? 'small_sub'
  const thresholds = (() => {
    if (preset === 'big_sub') {
      return { sev5u: 50, sev4u: 25, sev5c: 30, sev4c: 15 }
    }
    if (preset === 'custom') {
      return {
        sev5u: input.custom?.sev5_min_upvotes  ?? 20,
        sev4u: input.custom?.sev4_min_upvotes  ?? 10,
        sev5c: input.custom?.sev5_min_comments ?? 15,
        sev4c: input.custom?.sev4_min_comments ?? 8,
      }
    }
    return { sev5u: 20, sev4u: 10, sev5c: 15, sev4c: 8 } // small_sub
  })()

  // Engagement-driven tier
  let tier = 2
  if (input.upvotes >= thresholds.sev5u || input.comment_count >= thresholds.sev5c) tier = 5
  else if (input.upvotes >= thresholds.sev4u || input.comment_count >= thresholds.sev4c) tier = 4
  else if (input.upvotes >= 5 || input.comment_count >= 3) tier = 3
  else tier = 2

  // Keyword floor — scam/fraud/stolen/PSA always at least sev 3.
  const text = `${input.title} ${input.body}`.toLowerCase()
  const isSevereKeyword =
    /\b(scam|scammed|fraud|stolen|theft|psa|warning|alert|beware|avoid)\b/.test(text)

  if (isSevereKeyword) tier = Math.max(tier, 3)

  // Sev-1 demotion: very low engagement + non-complaint phrasing (question post).
  if (
    !isSevereKeyword
    && input.upvotes <= 2
    && input.comment_count <= 2
    && /^(is|are|does|do|can|will|should|how|why|what|when|where|which|who|anyone)\b/i.test(input.title.trim())
  ) {
    tier = 1
  }

  return tier
}

// ─── Keyword filter ─────────────────────────────────────────────────────────

/**
 * For big subs where a keyword filter is configured (e.g. "g2g,g2g.com"),
 * return true if the title or body contains any of the keywords (case
 * insensitive). Empty filter → always true (no filtering).
 */
export function keywordFilterMatches(filter: string, title: string, body: string): boolean {
  const tokens = filter.split(/[,;|\n]/).map(t => t.trim()).filter(Boolean)
  if (tokens.length === 0) return true
  const text = `${title} ${body}`.toLowerCase()
  return tokens.some(t => text.includes(t.toLowerCase()))
}
