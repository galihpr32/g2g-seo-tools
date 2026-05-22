// ─── Content Kit shared types ──────────────────────────────────────────────
//
// Sprint CKB.1 — single source of truth for the assembled kit shape.
// Stored as JSONB in content_kits.kit_data. Consumers: API endpoints,
// kit builder lib, UI modal, Bragi brief assembler.

export type IntentClass =
  | 'commercial-supportive'
  | 'commercial-investigation'
  | 'informational-pure'
  | 'diy-competing'

export type Market = 'us' | 'id'
export type Language = 'en' | 'id'

/** Strict filter: only commercial-supportive passes by default. */
export const STRICT_INTENT_WHITELIST: IntentClass[] = ['commercial-supportive']

/** Section in the product page blueprint. Each maps to one H2. */
export interface KitSection {
  position:      number                    // 1 = primary (above the fold), 2-N = below
  h2_title:      string                    // H2 heading rendered on the page
  target_kw:     string                    // supporting KW this section captures
  intent_class:  IntentClass               // intent of the target KW
  body_outline:  string                    // 2-3 sentence guidance for Bragi
  cta_bridge:    boolean                   // whether section needs a "buy now" CTA at end
  source:        'primary' | 'related_searches' | 'dfs_labs' | 'hugin' | 'paa'
}

/** Single FAQ pair, EN + ID side-by-side. */
export interface KitFaqItem {
  q_en:    string
  a_en:    string
  q_id:    string
  a_id:    string
  source:  'paa' | 'fan_out'
}

/** AI Overview-style passage, 50-80 words, citation-ready. */
export interface KitFanOutPassage {
  topic:           string
  passage_en:      string
  passage_id:      string
  section_hint:    string  // which section to drop this into (e.g. "How to Buy")
}

/** Where to place keywords on the page. */
export interface KitKeywordPlacement {
  primary:               string              // H1 + intro + conclusion + 2-3 body
  primary_variants:      string[]            // close variants in H2/H3, image alt
  supporting:            string[]            // one per H2 heading
  semantic_variations:   string[]            // image alt, microcopy, body prose
}

/** Cross-link to another product page in the catalog. */
export interface KitCrossLink {
  target_product_id:  string
  target_url:         string                  // resolved at brief-build time if blank
  anchor_text:        string
  reason:             'sibling-tier' | 'cross-tier-genre' | 'complementary'
}

/** Content gap analysis output from Haiku review of top-10 competitors. */
export interface KitGapAnalysis {
  competitor_urls:  string[]
  gaps: Array<{
    topic:     string
    why:       string             // 1-2 sentences explaining why this gap matters
    priority:  'high' | 'medium' | 'low'
  }>
}

/** Schema markup additions to render on the product page. */
export interface KitSchemaAdditions {
  faq_jsonld:       string        // ready-to-paste JSON-LD FAQPage block
  product_gaps:     string[]      // notes on missing Product schema properties
}

/** Top-level kit metadata. */
export interface KitMeta {
  generated_at:   string                       // ISO timestamp
  cost_estimate:  number                       // USD, rough
  sources: {
    dfs_serp_calls:        number
    dfs_labs_calls:        number
    hugin_candidates_used: number
    haiku_calls:           number
  }
  // Tracking for Mimir learning loop
  candidates_total:      number               // KWs evaluated
  candidates_passed:     number               // passed intent filter
  candidates_skipped:    number               // rejected (informational-pure etc.)
}

/** The full kit. Lives in content_kits.kit_data JSONB. */
export interface ContentKitData {
  sections:           KitSection[]
  faq:                KitFaqItem[]
  fan_out_passages:   KitFanOutPassage[]
  keyword_placement:  KitKeywordPlacement
  cross_links:        KitCrossLink[]
  gap_analysis:       KitGapAnalysis
  schema_additions:   KitSchemaAdditions
  meta:               KitMeta
}

// ─── Build input ───────────────────────────────────────────────────────────

export interface BuildKitInput {
  ownerId:            string
  productTierId:      string
  primaryKeywordId:   string
  primaryKeyword:     string
  market:             Market
  language:           Language
  /** How many H2 sections to aim for. Default 6. Hard cap 10. */
  targetSections?:    number
  /** Whether to include diy-competing KWs as counter-content (default false). */
  includeDiyCounter?: boolean
  /** Override siteSlug (for cross-link scope). Defaults to product's site. */
  siteSlug?:          string
}
