// ─── Content Kit orchestrator ──────────────────────────────────────────────
//
// Sprint CKB.2 — original orchestrator with DFS Labs as a candidate source.
// Sprint CKB.REL.1 — rewrite for relevance:
//   • DFS Labs DROPPED (returned irrelevant broad-modifier KWs for niche queries)
//   • NEW source: sibling tier_keywords (KWs user already curated for same product)
//   • Brand-token filter (stopwords list) applied BEFORE intent classify
//     → skips ~10-12 SERP scrape per kit for off-brand candidates → ~$0.010 saved
//   • Relevance ranking: related_searches > sibling_tier > hugin
//   • Build-with-available: no padding with low-quality candidates
//   • Haiku H2 heading polish (single batch call, +$0.005)
//   • Topic-aware body outlines (4 intents × 5 topics = 20 templates)
//
// Phases:
//   1. SERP scrape for primary KW           (DataForSEO Live Advanced)
//   2. Hugin candidate pull                  (long-tail from GSC)
//   3. Sibling tier_keywords pull            (curated by user, NEW)
//   4. Brand-token filter + relevance rank   (deterministic, no API calls)
//   5. Intent classification on filtered set (parallel SERP scrapes)
//   6. Fan-out generator                     (Haiku)
//   7. Content gap analysis                  (Haiku, after sections drafted)
//   8. Cross-link suggester                  (Supabase query)
//   9. Haiku heading polish on draft H2s     (batch Haiku call)
//   10. Assemble blueprint + FAQ + placement (deterministic)

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSerpData } from '@/lib/dataforseo/client'
import { classifyKeywordsBulk } from './intent-classifier'
import { generateFanOutPassages } from './fan-out'
import { analyzeContentGap } from './gap-analyzer'
import { suggestCrossLinks } from './cross-links'
import { polishHeadings, type DraftHeading } from './heading-polisher'
import type {
  BuildKitInput,
  ContentKitData,
  IntentClass,
  KitFaqItem,
  KitSection,
} from './types'

const LOCATION_BY_MARKET: Record<'us' | 'id', { code: number; lang: string }> = {
  us: { code: 2840, lang: 'en' },
  id: { code: 2360, lang: 'id' },
}

// Sprint CKB.REL.1 — KW modifier stopwords. These are generic SEO modifier
// words that aren't BRAND tokens. A candidate that shares only a stopword
// with the primary (e.g. "cheap minecraft key" sharing "cheap" with
// "cheap bns gold") gets filtered out. Cuts off-brand noise from DFS Labs
// and PAA when primary is a niche product.
const KW_STOPWORDS = new Set([
  // Modifier adjectives
  'cheap', 'best', 'top', 'fast', 'safe', 'secure', 'legit', 'free', 'low',
  'high', 'pro', 'premium', 'discount', 'discounted', 'budget', 'instant',
  'quick', 'easy', 'simple', 'reliable', 'trusted', 'official', 'genuine',
  // Action verbs
  'buy', 'get', 'sell', 'sale', 'order', 'purchase', 'trade', 'find',
  // Wh-words
  'how', 'where', 'when', 'why', 'what', 'who', 'which',
  // Generic nouns common in commercial KWs
  'price', 'prices', 'deal', 'deals', 'online', 'website', 'site', 'store',
  'shop', 'market', 'marketplace', 'tips', 'guide', 'review', 'reviews',
  // Particles
  'to', 'for', 'with', 'from', 'in', 'on', 'at', 'of', 'and', 'or', 'the',
  'a', 'an', 'is', 'are', 'be', 'i', 'you', 'my', 'your',
])

function extractBrandTokens(kw: string): Set<string> {
  const tokens = String(kw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !KW_STOPWORDS.has(t))
  return new Set(tokens)
}

// Sprint CKB.BRAND-ALIAS.2 — generic gaming terms that aren't brand-specific.
// "gold" is used by Blade & Soul Neo, Standoff 2, WoW, RuneScape, etc., so a
// candidate sharing ONLY "gold" with the primary keyword isn't enough proof
// it's the same game. Filter rule downstream: a candidate must share ≥1
// SPECIFIC (non-generic) token with the primary brand context to pass.
const GENERIC_GAMING_TOKENS = new Set([
  // Virtual currency
  'gold', 'silver', 'coins', 'coin', 'gems', 'gem', 'currency', 'money',
  'cash', 'credits', 'tokens', 'token', 'points',
  // Account / membership
  'account', 'accounts', 'login', 'membership', 'sub', 'subscription',
  // Top-up / recharge mechanics
  'top', 'up', 'topup', 'recharge', 'reload',
  // Items / drops
  'item', 'items', 'drop', 'drops', 'loot', 'chest', 'box', 'crate',
  // Services
  'farm', 'farming', 'boost', 'boosting', 'leveling', 'level', 'levelup',
  'powerleveling', 'powerlevel', 'service', 'services',
  // Digital goods
  'key', 'keys', 'cdkey', 'cdkeys', 'code', 'codes',
  'gift', 'card', 'cards',
])

function isSpecificToken(t: string): boolean {
  return !GENERIC_GAMING_TOKENS.has(t)
}

interface BrandTokenContext {
  specific: Set<string>
  generic:  Set<string>
}

/**
 * Sprint CKB.BRAND-ALIAS.2 — build the brand-token context once, merging
 * tokens from the primary keyword + product brand_canonical + manual
 * brand_aliases + Hugin-mined aliases (Phase 2). Splits into specific
 * vs generic so the filter can require at least one specific match.
 */
function buildBrandContext(primary: string, product: ProductContext): BrandTokenContext {
  const all = new Set<string>()
  for (const t of extractBrandTokens(primary))                       all.add(t)
  for (const t of extractBrandTokens(product.brand_canonical ?? '')) all.add(t)
  for (const alias of product.brand_aliases ?? []) {
    for (const t of extractBrandTokens(alias)) all.add(t)
  }
  const specific = new Set<string>()
  const generic  = new Set<string>()
  for (const t of all) {
    if (isSpecificToken(t)) specific.add(t)
    else                    generic.add(t)
  }
  return { specific, generic }
}

interface ProductContext {
  product_name:    string
  category:        string | null
  brand_canonical: string | null
  brand_aliases:   string[]      // Sprint CKB.BRAND-ALIAS.1
  url:             string | null
  site_slug:       string
}

async function loadProductContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, productTierId: string,
): Promise<ProductContext | null> {
  const { data } = await db
    .from('product_tiers')
    .select('product_name, category, brand_canonical, brand_aliases, url, site_slug')
    .eq('id', productTierId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (!data) return null
  // Sprint CKB.BRAND-ALIAS.2 — defensive default: column was just added; existing
  // rows may return undefined until they're re-saved.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = data as any
  return {
    product_name:    row.product_name,
    category:        row.category,
    brand_canonical: row.brand_canonical,
    brand_aliases:   Array.isArray(row.brand_aliases) ? row.brand_aliases : [],
    url:             row.url,
    site_slug:       row.site_slug,
  }
}

interface HuginRow { query: string; growth_pct: number | null; intent_class: string | null }

async function loadHuginCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, siteSlug: string, brandCtx: BrandTokenContext,
): Promise<string[]> {
  // Sprint CKB.BRAND-ALIAS.2 — require ≥1 SPECIFIC token match (not just any).
  // If specific is empty, we have no brand identity to filter on, so skip.
  if (brandCtx.specific.size === 0) return []
  const { data } = await db
    .from('hugin_queries')
    .select('query, growth_pct, intent_class')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('period_days', 30)
    .eq('status', 'discovered')
    .order('growth_pct', { ascending: false, nullsFirst: false })
    .limit(80)
  const rows = (data ?? []) as HuginRow[]
  return rows
    .filter(r => r.intent_class !== 'informational-pure' && r.intent_class !== 'diy-competing')
    .filter(r => {
      if (!r.query) return false
      // Require shared SPECIFIC brand token. Sharing only generic ("gold")
      // is no longer enough — that's what let "standoff 2 top up gold"
      // leak into a Blade & Soul Neo kit before this sprint.
      const tokens = extractBrandTokens(r.query)
      for (const t of tokens) if (brandCtx.specific.has(t)) return true
      return false
    })
    .map(r => String(r.query))
    .slice(0, 10)
}

/**
 * Sprint CKB.REL.1 — Load other tier_keywords for the same product as
 * candidate supporting KWs. These are curated by the user manually, so
 * they're guaranteed relevant to the product. Filter ensures we exclude
 * the primary KW itself.
 */
async function loadSiblingTierKeywords(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  ownerId: string,
  productTierId: string,
  primaryKeywordId: string,
): Promise<string[]> {
  const { data } = await db
    .from('tier_keywords')
    .select('keyword, competitive_score')
    .eq('owner_user_id', ownerId)
    .eq('product_tier_id', productTierId)
    .neq('id', primaryKeywordId)
    .order('competitive_score', { ascending: false, nullsFirst: false })
    .limit(20)
  return (data ?? [])
    .map(r => String(r.keyword ?? '').trim())
    .filter(Boolean)
}

// ─── Candidate filter + rank ───────────────────────────────────────────────

interface CandidateKw {
  keyword:    string
  source:     KitSection['source']
  relevance:  number       // computed by filterAndRankCandidates
}

interface CandidateInput {
  keyword: string
  source:  KitSection['source']
}

/**
 * Sprint CKB.REL.1 + CKB.BRAND-ALIAS.2 — Apply brand-token filter + ranking.
 *
 * Filter rule (post-#334): candidate must share ≥1 SPECIFIC token with the
 * brand context. Specific = non-generic-gaming (gold, key, account, etc.
 * are generic and don't count alone). The brand context blends tokens from
 * primary KW + product.brand_canonical + product.brand_aliases — so "bns"
 * counts as specific even when primary is "cheap gold for blade soul neo".
 *
 * Before this sprint, sharing only "gold" was enough → "standoff 2 top up
 * gold" leaked into Blade & Soul Neo kits.
 *
 * Score formula:
 *   12 × (shared specific tokens)        — high signal
 *   + 3 × (shared generic tokens)        — weak signal, still useful for tie-break
 *   + source priority bonus:
 *       related_searches = +5  (most contextual to primary SERP)
 *       paa              = +5  (also tied to primary SERP)
 *       sibling_tier     = +3  (curated by user)
 *       hugin            = +2  (real GSC long-tail data)
 *
 * Fallback: if brandCtx.specific is empty (no brand identity at all), we
 * still pass on shared generic tokens so the kit doesn't blow up — but the
 * caller should warn (loadProductContext will have empty brand_canonical +
 * brand_aliases AND the primary KW has no specific token).
 */
function filterAndRankCandidates(
  items: CandidateInput[],
  primary:  string,
  brandCtx: BrandTokenContext,
): { passed: CandidateKw[]; offBrand: number } {
  const seen = new Set([String(primary ?? '').toLowerCase()])
  const out: CandidateKw[] = []
  let offBrand = 0
  const noSpecificFallback = brandCtx.specific.size === 0

  for (const c of items) {
    const raw = (c?.keyword ?? '').toString().trim()
    if (!raw) continue
    const k = raw.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)

    // Specific vs generic intersection
    const candTokens = extractBrandTokens(raw)
    let sharedSpecific = 0
    let sharedGeneric  = 0
    for (const t of candTokens) {
      if      (brandCtx.specific.has(t)) sharedSpecific++
      else if (brandCtx.generic.has(t))  sharedGeneric++
    }

    // Gate: must share ≥1 specific token (unless brandCtx has no specific
    // tokens at all — then fall back to ≥1 generic match)
    if (noSpecificFallback) {
      if (sharedGeneric === 0) { offBrand++; continue }
    } else if (sharedSpecific === 0) {
      offBrand++
      continue
    }

    // Score
    const sourceBonus =
      c.source === 'related_searches' ? 5 :
      c.source === 'paa'              ? 5 :
      c.source === 'sibling_tier'     ? 3 :
      c.source === 'hugin'            ? 2 : 0
    const relevance = sharedSpecific * 12 + sharedGeneric * 3 + sourceBonus

    out.push({ keyword: raw, source: c.source, relevance })
  }

  out.sort((a, b) => b.relevance - a.relevance)
  return { passed: out, offBrand }
}

// ─── Section drafting (with topic-aware outline) ───────────────────────────

function capitalize(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

type BodyTopic = 'safety' | 'delivery' | 'comparison' | 'value' | 'general'

function detectTopic(kw: string): BodyTopic {
  const k = kw.toLowerCase()
  if (/\b(safe|legit|ban|trust|scam|secure|risk|verified)\b/.test(k)) return 'safety'
  if (/\b(fast|instant|quick|delivery|hour|minute|today|now|express|same.?day)\b/.test(k)) return 'delivery'
  if (/\b(best|top|vs|versus|compare|comparison|seller|review|alternative|farming|farm|grind)\b/.test(k)) return 'comparison'
  if (/\b(cheap|cheapest|discount|deal|price|low|budget|affordable|sale)\b/.test(k)) return 'value'
  return 'general'
}

/**
 * Sprint CKB.REL.1 — Topic-aware body outline. 4 intents × 5 topics = 20
 * variants. Drives Bragi to produce more diverse content vs the previous
 * generic template that repeated for every section.
 */
function bodyOutlineFor(kw: string, intent: IntentClass, productName: string): string {
  const topic = detectTopic(kw)

  if (intent === 'commercial-supportive') {
    switch (topic) {
      case 'safety':     return `Trust + safety section on "${kw}". 100-140 words. Highlight buyer protection, escrow, verified seller program, refund policy. Include 1 specific stat or guarantee. End with CTA back to Buy.`
      case 'delivery':   return `Delivery focus on "${kw}". 100-140 words. State actual delivery windows (e.g. 5-15 minutes), platform coverage (PC/console/mobile), and what happens if delayed. End with CTA back to Buy.`
      case 'value':      return `Value/pricing section on "${kw}". 100-140 words. Show package tiers (small/mid/bulk) with concrete savings, highlight bulk-buy discount if any, mention price-match if applicable. End with CTA.`
      case 'comparison': return `Direct comparison on "${kw}". 100-140 words. Position ${productName} as the easier path vs the alternative. 2-3 concrete advantages (price, speed, support). End with CTA.`
      case 'general':    return `Address "${kw}" specifically. 120-160 words. Include 1-2 specific value props relevant to this query (delivery, payment options, support coverage). End with CTA back to Buy section.`
    }
  }
  if (intent === 'commercial-investigation') {
    switch (topic) {
      case 'safety':     return `Research-intent on "${kw}". 100-140 words. Compare safety mechanisms across alternatives — explain why ${productName} marketplace protections beat generic options. STRONG CTA bridge.`
      case 'delivery':   return `Compare delivery options for "${kw}". 100-140 words. Acknowledge alternatives (DIY, other markets), then show ${productName} delivery SLA + recovery guarantees. STRONG CTA bridge.`
      case 'value':      return `Value comparison for "${kw}". 100-140 words. Acknowledge cheaper alternatives exist but explain hidden cost (time, risk, ban exposure). Position ${productName} as net-positive. STRONG CTA bridge.`
      case 'comparison': return `Direct comparison addressing "${kw}". 100-140 words. Honest assessment of 2-3 alternatives, then end with ${productName}'s differentiator. STRONG CTA bridge required.`
      case 'general':    return `Comparison/research intent on "${kw}". 100-140 words. Acknowledge the alternative, then position ${productName} as easier path. STRONG CTA bridge at end.`
    }
  }
  if (intent === 'diy-competing') {
    switch (topic) {
      case 'safety':     return `Counter-content for "${kw}". 100-140 words. Acknowledge DIY safety appeal but surface real risks (ban exposure, account suspension, scam exposure). Reframe as time + risk savings. CTA required.`
      case 'delivery':   return `Counter-content for "${kw}". 100-140 words. DIY = waiting for drops/cooldowns. Buying = instant. Make the time math explicit. CTA required.`
      case 'value':      return `Counter-content for "${kw}". 100-140 words. "Cheap" via DIY = hours/days of grind. Quantify hourly time cost. ${productName} = predictable cost. CTA required.`
      case 'comparison': return `Counter-content for "${kw}". 100-140 words. Honest about DIY pros, then surface 3 cons (volatility, opportunity cost, ban risk). Bridge to ${productName}. CTA required.`
      case 'general':    return `Counter-content for "${kw}". 100-140 words. Acknowledge DIY pain points (time, risk, ban exposure, market volatility). Reframe buying as time-saver. CTA required.`
    }
  }
  // informational-pure (shouldn't be a section, defensive default)
  return `Informational entry — keep to 60-80 words inside FAQ section. Do NOT make standalone H2. Brief answer + link/CTA to relevant Buy section.`
}

function draftHeadingFallback(
  kw: string, intent: IntentClass, productName: string,
): string {
  switch (intent) {
    case 'commercial-supportive':    return capitalize(kw)
    case 'commercial-investigation': return `${capitalize(kw)} vs Buying from ${productName}`
    case 'diy-competing':            return `${capitalize(kw)}: Why Buying Saves Time`
    case 'informational-pure':       return capitalize(kw)
  }
}

// ─── PAA → FAQ ─────────────────────────────────────────────────────────────

function paaToFaq(paaQuestions: string[], language: 'en' | 'id'): KitFaqItem[] {
  return paaQuestions.slice(0, 8).map(q => ({
    q_en:    language === 'en' ? q : `(EN) ${q}`,
    a_en:    '(Answer to be populated by Bragi — 40-80 words, citation-ready)',
    q_id:    language === 'id' ? q : `(ID) ${q}`,
    a_id:    '(Jawaban akan diisi Bragi — 40-80 kata, AI Overview-ready)',
    source:  'paa' as const,
  }))
}

// ─── Public entry ──────────────────────────────────────────────────────────

/**
 * Build the full content kit. Main entry — invoked by /api/content-kit/build
 * via after() so HTTP returns immediately.
 *
 * Total runtime: ~30-45 seconds typical (cold start adds ~10s).
 * Total cost:    ~$0.025-0.030 per kit after CKB.REL.1 (was $0.037).
 */
export async function buildContentKit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  input: BuildKitInput,
): Promise<ContentKitData> {
  const productCtx = await loadProductContext(db, input.ownerId, input.productTierId)
  if (!productCtx) throw new Error(`Product ${input.productTierId} not found`)
  const siteSlug = input.siteSlug ?? productCtx.site_slug

  const { code: locationCode, lang: languageCode } = LOCATION_BY_MARKET[input.market]
  const targetSections = Math.min(input.targetSections ?? 6, 10)
  // Sprint CKB.BRAND-ALIAS.2 — brand context now blends primary KW +
  // brand_canonical + brand_aliases, split into specific vs generic tokens.
  const brandCtx = buildBrandContext(input.primaryKeyword, productCtx)

  // ─── Phase 1: Parallel data fetches (SERP + Hugin + siblings + cross-links) ─
  const [primarySerp, huginCandidates, siblingKws, crossLinks] = await Promise.all([
    getSerpData(input.primaryKeyword, locationCode, languageCode, 10).catch(() => null),
    loadHuginCandidates(db, input.ownerId, siteSlug, brandCtx),
    loadSiblingTierKeywords(db, input.ownerId, input.productTierId, input.primaryKeywordId),
    suggestCrossLinks({
      db, ownerId: input.ownerId, productTierId: input.productTierId, siteSlug, limit: 5,
    }),
  ])
  if (!primarySerp) throw new Error('SERP scrape failed for primary keyword')

  // ─── Phase 2: Assemble candidate pool from 4 sources (no DFS Labs) ────────
  const candidatePool: CandidateInput[] = [
    ...primarySerp.relatedSearches.map(r => ({ keyword: r.query, source: 'related_searches' as const })),
    ...primarySerp.peopleAlsoAsk.map(p => ({ keyword: p.question, source: 'paa' as const })),
    ...siblingKws.map(k => ({ keyword: k, source: 'sibling_tier' as const })),
    ...huginCandidates.map(q => ({ keyword: q, source: 'hugin' as const })),
  ]

  // ─── Phase 3: Brand-token filter + relevance rank (deterministic) ─────────
  const { passed: rankedCandidates, offBrand: candidates_off_brand } =
    filterAndRankCandidates(candidatePool, input.primaryKeyword, brandCtx)
  // Cap at 15 for intent classification (saves SERP scrape cost)
  const candidates = rankedCandidates.slice(0, 15)

  // ─── Phase 4: Classify intent for filtered candidates (parallel SERP scrapes) ─
  const intentMap = await classifyKeywordsBulk(
    candidates.map(c => c.keyword), input.market, 5,
  )

  // ─── Phase 5: Filter by intent — keep commercial-supportive, then investigation ─
  const passed: Array<CandidateKw & { intent_class: IntentClass }> = []
  let candidates_skipped = 0
  for (const c of candidates) {
    const v = intentMap.get(c.keyword.toLowerCase())
    if (!v) { candidates_skipped++; continue }
    if (v.intent_class === 'commercial-supportive') {
      passed.push({ ...c, intent_class: v.intent_class })
    } else if (v.intent_class === 'diy-competing' && input.includeDiyCounter) {
      passed.push({ ...c, intent_class: v.intent_class })
    } else if (v.intent_class === 'commercial-investigation') {
      passed.push({ ...c, intent_class: v.intent_class })
    } else {
      candidates_skipped++
    }
  }
  // Re-sort by relevance to ensure best candidates first (already sorted but
  // intent filter may have changed ordering)
  passed.sort((a, b) => b.relevance - a.relevance)

  // ─── Phase 6: Draft sections (primary + as many supporting as we have) ────
  // Sprint CKB.REL.1: build-with-available. If we only got 2 valid supporting
  // candidates, build 3-section kit, NOT pad with low-quality picks.
  const supportingCount = Math.min(targetSections - 1, passed.length)
  const draftHeadings: DraftHeading[] = [
    {
      target_kw:    input.primaryKeyword,
      intent_class: 'commercial-supportive',
      draft:        `${capitalize(productCtx.product_name)} — ${capitalize(input.primaryKeyword)}`,
    },
    ...passed.slice(0, supportingCount).map(c => ({
      target_kw:    c.keyword,
      intent_class: c.intent_class,
      draft:        draftHeadingFallback(c.keyword, c.intent_class, productCtx.product_name),
    })),
  ]

  // ─── Phase 7: Parallel Haiku calls (fan-out + gap analysis + heading polish) ─
  const [fanOutResult, gapResult, polishResult] = await Promise.all([
    generateFanOutPassages({
      primaryKeyword: input.primaryKeyword,
      productName:    productCtx.product_name,
      category:       productCtx.category ?? undefined,
      market:         input.market,
      targetCount:    10,
    }),
    analyzeContentGap({
      primaryKeyword:   input.primaryKeyword,
      productName:      productCtx.product_name,
      topResults:       primarySerp.organicResults,
      currentSections:  draftHeadings.map(d => d.draft),
    }),
    polishHeadings(draftHeadings, {
      productName: productCtx.product_name,
      market:      input.market,
    }),
  ])

  // ─── Phase 8: Assemble final sections with polished headings + topic outlines ─
  const sections: KitSection[] = []
  // Primary
  sections.push({
    position:     1,
    h2_title:     polishResult.headings[0] ?? draftHeadings[0].draft,
    target_kw:    input.primaryKeyword,
    intent_class: 'commercial-supportive',
    body_outline: `Primary commercial intent section. Open with price + delivery + CTA. Reinforce trust signals (rating, completion rate, refund policy). Target "${input.primaryKeyword}" naturally in intro paragraph + conclusion.`,
    cta_bridge:   false,
    source:       'primary',
    relevance:    100,
  })
  // Supporting
  for (let i = 0; i < supportingCount; i++) {
    const c = passed[i]
    sections.push({
      position:     i + 2,
      h2_title:     polishResult.headings[i + 1] ?? draftHeadings[i + 1].draft,
      target_kw:    c.keyword,
      intent_class: c.intent_class,
      body_outline: bodyOutlineFor(c.keyword, c.intent_class, productCtx.product_name),
      cta_bridge:   true,
      source:       c.source,
      relevance:    c.relevance,
    })
  }

  // ─── Phase 9: Assemble FAQ (PAA + selected fan-out) ──────────────────────
  const faq: KitFaqItem[] = [
    ...paaToFaq(primarySerp.peopleAlsoAsk.map(p => p.question).slice(0, 6), input.language),
    ...fanOutResult.passages.slice(0, 2).map(p => ({
      q_en:   p.topic + '?',
      a_en:   p.passage_en,
      q_id:   p.topic + '?',
      a_id:   p.passage_id,
      source: 'fan_out' as const,
    })),
  ]

  // ─── Phase 10: Keyword placement map ─────────────────────────────────────
  const keyword_placement = {
    primary:              input.primaryKeyword,
    primary_variants:     sections.slice(1).map(s => s.target_kw).slice(0, 3),
    supporting:           sections.slice(1).map(s => s.target_kw),
    semantic_variations:  primarySerp.relatedSearches.map(r => r.query).slice(0, 8),
  }

  // ─── Phase 11: Schema additions (FAQPage JSON-LD pre-rendered) ───────────
  const faq_jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type':    'FAQPage',
    mainEntity: faq.slice(0, 8).map(f => ({
      '@type': 'Question',
      name:    input.language === 'id' ? f.q_id : f.q_en,
      acceptedAnswer: {
        '@type': 'Answer',
        text:    input.language === 'id' ? f.a_id : f.a_en,
      },
    })),
  })

  // ─── Final assembly ──────────────────────────────────────────────────────
  return {
    sections,
    faq,
    fan_out_passages:   fanOutResult.passages,
    keyword_placement,
    cross_links:        crossLinks,
    gap_analysis:       gapResult.gap_analysis,
    schema_additions:   { faq_jsonld, product_gaps: [] },
    meta: {
      generated_at:  new Date().toISOString(),
      cost_estimate:
        0.002                            // primary SERP
        + candidates.length * 0.001      // per-candidate intent SERP
        + fanOutResult.ai_call_cost      // ~$0.012
        + gapResult.ai_call_cost         // ~$0.010
        + polishResult.ai_call_cost,     // ~$0.005
      sources: {
        dfs_serp_calls:        1 + candidates.length,
        dfs_labs_calls:        0,        // Sprint CKB.REL.1 — dropped
        hugin_candidates_used: huginCandidates.length,
        haiku_calls:           3,        // fan-out + gap + heading-polish
      },
      candidates_total:      candidatePool.length,
      candidates_passed:     passed.length,
      candidates_skipped,
      candidates_off_brand,
      target_sections:       targetSections,
      delivered_sections:    sections.length,
    },
  }
}
