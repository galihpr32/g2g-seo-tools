// ─── Content Kit orchestrator ──────────────────────────────────────────────
//
// Sprint CKB.2 — Main entry. Takes a primary KW and assembles a full kit
// by running these phases (most in parallel):
//
//   1. SERP scrape for primary KW           (DataForSEO Live Advanced)
//   2. DFS Labs related_keywords expansion  (semantic variations)
//   3. Hugin candidate pull                  (long-tail from GSC)
//   4. Intent classification per candidate   (~15 parallel SERP scrapes)
//   5. Fan-out generator                     (Haiku)
//   6. Content gap analysis                  (Haiku, after sections drafted)
//   7. Cross-link suggester                  (Supabase query)
//   8. Assemble blueprint + FAQ + placement  (deterministic)
//
// Output: a ContentKitData object ready to persist into content_kits.kit_data.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSerpData, getKeywordSuggestions } from '@/lib/dataforseo/client'
import { classifyKeywordsBulk } from './intent-classifier'
import { generateFanOutPassages } from './fan-out'
import { analyzeContentGap } from './gap-analyzer'
import { suggestCrossLinks } from './cross-links'
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

interface ProductContext {
  product_name:    string
  category:        string | null
  brand_canonical: string | null
  url:             string | null
  site_slug:       string
}

async function loadProductContext(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, productTierId: string,
): Promise<ProductContext | null> {
  const { data } = await db
    .from('product_tiers')
    .select('product_name, category, brand_canonical, url, site_slug')
    .eq('id', productTierId)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  return data ? (data as ProductContext) : null
}

interface HuginRow { query: string; growth_pct: number | null; intent_class: string | null }

async function loadHuginCandidates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>, ownerId: string, siteSlug: string, primaryKeyword: string,
): Promise<string[]> {
  // Pull discovered queries that contain primary keyword tokens.
  const tokens = String(primaryKeyword ?? '').toLowerCase().split(/\s+/).filter(t => t.length >= 3)
  if (tokens.length === 0) return []
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
  // Sprint CKB.5 — pre-filter Hugin intent. Skip rows we already know are
  // informational-pure (saves a SERP classification call per skipped row).
  // NULL passes through so the kit builder's own classifier can decide.
  return rows
    .filter(r => r.intent_class !== 'informational-pure' && r.intent_class !== 'diy-competing')
    .filter(r => {
      if (!r.query) return false
      const q = String(r.query).toLowerCase()
      return tokens.some(t => q.includes(t))
    })
    .map(r => String(r.query))
    .slice(0, 10)
}

// ─── Section drafting ──────────────────────────────────────────────────────

interface CandidateKw {
  keyword:    string
  source:     KitSection['source']
  // intent_class filled in later
}

function dedupeCandidates(items: CandidateKw[], primary: string): CandidateKw[] {
  // Sprint CKB.HARDEN — DFS Labs + SERP sometimes return entries with
  // missing/empty keyword field. Filter null/undefined/empty BEFORE we
  // call .toLowerCase() to avoid runtime crash on niche queries.
  const seen = new Set([String(primary ?? '').toLowerCase()])
  const out: CandidateKw[] = []
  for (const c of items) {
    const raw = (c?.keyword ?? '').toString().trim()
    if (!raw) continue
    const k = raw.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ keyword: raw, source: c.source })
  }
  return out
}

function draftSection(
  position: number,
  primaryKeyword: string,
  productName: string,
  candidate: { keyword: string; intent_class: IntentClass; source: KitSection['source'] },
): KitSection {
  const isPrimary = position === 1
  const cta = candidate.intent_class === 'commercial-investigation' || candidate.intent_class === 'diy-competing'
  const h2 = isPrimary
    ? `${capitalize(productName)} — ${capitalize(candidate.keyword)}`
    : sectionHeadingFor(candidate.keyword, productName)
  const body = isPrimary
    ? `Primary commercial intent section. Open with price + delivery + CTA. Reinforce trust signals (rating, completion rate, refund policy). Target ${primaryKeyword} naturally in intro paragraph + conclusion.`
    : bodyOutlineFor(candidate.keyword, candidate.intent_class, productName)
  return {
    position,
    h2_title:     h2,
    target_kw:    candidate.keyword,
    intent_class: candidate.intent_class,
    body_outline: body,
    cta_bridge:   cta || !isPrimary,   // every non-primary section needs a bridge
    source:       candidate.source,
  }
}

function capitalize(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

function sectionHeadingFor(kw: string, productName: string): string {
  const k = kw.toLowerCase()
  if (/safe|secure|trust|legit|ban/.test(k)) return `How to Buy ${productName} Safely`
  if (/delivery|fast|instant|cross.?platform/.test(k)) return `${productName} Delivery: Speed & Platforms`
  if (/cheap|price|cheapest|deal/.test(k)) return `Cheap ${productName} Packages`
  if (/vs|compare|comparison|farm|grind/.test(k)) return `${productName} vs Farming Yourself`
  if (/best|top|recommend/.test(k)) return `Best ${productName} Packages`
  if (/account|registration|sign/.test(k)) return `${productName} Account & Registration`
  if (/payment|paypal|wallet/.test(k)) return `${productName} Payment Methods`
  return capitalize(kw)
}

function bodyOutlineFor(kw: string, intent: IntentClass, productName: string): string {
  switch (intent) {
    case 'commercial-supportive':
      return `Address the specific intent of "${kw}". 120-180 words. Include 1-2 specific value props (e.g. delivery time, refund policy, payment method coverage). End with CTA back to Buy section.`
    case 'commercial-investigation':
      return `Comparison/research intent on "${kw}". 100-150 words. Acknowledge the alternative, then position ${productName} as the easier path. STRONG CTA bridge required at end.`
    case 'diy-competing':
      return `Counter-content for "${kw}". 100-150 words. Acknowledge DIY pain points (time, risk, ban exposure, market volatility). Reframe buying as a time-saver. CTA bridge mandatory.`
    case 'informational-pure':
      return `Informational entry — keep to 60-80 words inside the FAQ section. Do NOT make this a standalone H2. Brief answer + link/CTA to relevant Buy section.`
  }
}

// ─── PAA → FAQ ─────────────────────────────────────────────────────────────

function paaToFaq(paaQuestions: string[], language: 'en' | 'id'): KitFaqItem[] {
  // We let the kit UI / Bragi flow fill in proper answers later.
  // Here we just stub the structure so the kit has FAQ slots ready.
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
 * Build the full content kit. This is the main entry point — typically
 * invoked by /api/content-kit/build (via after() so the HTTP response
 * returns immediately while the build continues in background).
 *
 * Total runtime: ~30-45 seconds for a typical kit.
 * Total cost:    ~$0.037 (see slide 8 of the boss deck).
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

  // ─── Phase 1: Primary SERP scrape + parallel data fetches ────────────────
  const [primarySerp, suggestedKws, huginCandidates, crossLinks] = await Promise.all([
    getSerpData(input.primaryKeyword, locationCode, languageCode, 10).catch(() => null),
    getKeywordSuggestions(input.primaryKeyword, locationCode, languageCode, 20).catch(() => []),
    loadHuginCandidates(db, input.ownerId, siteSlug, input.primaryKeyword),
    suggestCrossLinks({
      db, ownerId: input.ownerId, productTierId: input.productTierId, siteSlug, limit: 5,
    }),
  ])
  if (!primarySerp) throw new Error('SERP scrape failed for primary keyword')

  // ─── Phase 2: Assemble candidate pool ────────────────────────────────────
  const candidates: CandidateKw[] = dedupeCandidates([
    ...primarySerp.relatedSearches.map(r => ({ keyword: r.query, source: 'related_searches' as const })),
    ...suggestedKws.map(k => ({ keyword: k.keyword, source: 'dfs_labs' as const })),
    ...huginCandidates.map(q => ({ keyword: q, source: 'hugin' as const })),
  ], input.primaryKeyword).slice(0, 15)

  // ─── Phase 3: Classify intent for each candidate (parallel SERP scrapes) ─
  const intentMap = await classifyKeywordsBulk(
    candidates.map(c => c.keyword), input.market, 5,
  )

  // ─── Phase 4: Filter — strict mode keeps only commercial-supportive ──────
  //  diy-competing only if includeDiyCounter=true (counter-content treatment)
  const passed: Array<CandidateKw & { intent_class: IntentClass }> = []
  let candidates_skipped = 0
  for (const c of candidates) {
    if (!c.keyword) { candidates_skipped++; continue }
    const v = intentMap.get(c.keyword.toLowerCase())
    if (!v) { candidates_skipped++; continue }
    if (v.intent_class === 'commercial-supportive') {
      passed.push({ ...c, intent_class: v.intent_class })
    } else if (v.intent_class === 'diy-competing' && input.includeDiyCounter) {
      passed.push({ ...c, intent_class: v.intent_class })
    } else if (v.intent_class === 'commercial-investigation' && passed.length < targetSections - 1) {
      // Allow some investigation KWs if we don't have enough commercial ones
      passed.push({ ...c, intent_class: v.intent_class })
    } else {
      candidates_skipped++
    }
  }

  // ─── Phase 5: Draft sections (primary first + top supporting) ────────────
  const sections: KitSection[] = []
  sections.push(draftSection(1, input.primaryKeyword, productCtx.product_name, {
    keyword:      input.primaryKeyword,
    intent_class: 'commercial-supportive',
    source:       'primary',
  }))
  for (let i = 0; i < Math.min(targetSections - 1, passed.length); i++) {
    sections.push(draftSection(i + 2, input.primaryKeyword, productCtx.product_name, passed[i]))
  }

  // ─── Phase 6: Fan-out + gap analysis (parallel Haiku calls) ──────────────
  const [fanOutResult, gapResult] = await Promise.all([
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
      currentSections:  sections.map(s => s.h2_title),
    }),
  ])

  // ─── Phase 7: Assemble FAQ (PAA + selected fan-out) ──────────────────────
  const faq: KitFaqItem[] = [
    ...paaToFaq(primarySerp.peopleAlsoAsk.map(p => p.question).slice(0, 6), input.language),
    // Top 2 fan-out passages → also exposed as FAQ entries for AI Overview lift
    ...fanOutResult.passages.slice(0, 2).map(p => ({
      q_en:   p.topic + '?',
      a_en:   p.passage_en,
      q_id:   p.topic + '?',
      a_id:   p.passage_id,
      source: 'fan_out' as const,
    })),
  ]

  // ─── Phase 8: Keyword placement map (deterministic) ──────────────────────
  const keyword_placement = {
    primary:              input.primaryKeyword,
    primary_variants:     sections.slice(1).map(s => s.target_kw).slice(0, 3),
    supporting:           sections.slice(1).map(s => s.target_kw),
    semantic_variations:  primarySerp.relatedSearches.map(r => r.query).slice(0, 8),
  }

  // ─── Phase 9: Schema additions (FAQPage JSON-LD pre-rendered) ────────────
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
      cost_estimate: 0.002 + 0.005 + candidates.length * 0.001 + fanOutResult.ai_call_cost + gapResult.ai_call_cost,
      sources: {
        dfs_serp_calls:        1 + candidates.length,   // primary + per-candidate intent
        dfs_labs_calls:        1,
        hugin_candidates_used: huginCandidates.length,
        haiku_calls:           (fanOutResult.passages === fanOutResult.passages ? 1 : 0) + (gapResult.gap_analysis.gaps.length > 0 ? 1 : 0),
      },
      candidates_total:    candidates.length,
      candidates_passed:   passed.length,
      candidates_skipped,
    },
  }
}
