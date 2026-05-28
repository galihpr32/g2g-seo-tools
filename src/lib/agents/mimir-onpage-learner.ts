// Sprint MIMIR.ONPAGE — On-page pattern learner.
//
// Galih multi-selects N pages (typically T1 + T2 leaders that are
// converting). For each page we fetch the live HTML or its stored brief
// content, then ask Haiku to extract patterns across 6 dimensions:
//
//   1. h1_pattern          — H1 phrasing structure (keyword position, length)
//   2. intro_pattern       — Lead paragraph style (length, hook, value prop)
//   3. h2_cadence          — Section count + typical H2 wording
//   4. trust_signal_usage  — Where GamerProtect / ISO / payment refs land
//   5. cta_pattern         — Call-to-action style + frequency
//   6. internal_link_style — Anchor text patterns + link density
//
// Sprint MIMIR.POLISH.4 — disciplined classification:
//   • RULE       = pattern observable across ≥3 pages, absolute "always/never"
//   • PREFERENCE = pattern observable across ≥2 pages, soft tendency
//   • FACT       = factual statement about the brand/product, not a directive
//   • LESSON     = past mistake corrected by team (rarely produced here;
//                  most lessons come from brief_review_feedback table)
//
// Each extracted pattern becomes one mimir_memories row with:
//   category   = (model-classified, see above)
//   scope      = 'site'
//   tags       = ['onpage', dimension, ...]
//   source_url = first page URL that exhibits the pattern (for trace-back)
//
// Replace strategy (UI option): when enabled, we delete existing memories
// with the same (site_slug, onpage_dimension, scope=site) before
// inserting new ones. Otherwise we append — useful for "learn more from
// fresh pages while keeping the old learnings".

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logClaudeUsage } from '@/lib/api-logger'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = process.env.MIMIR_ONPAGE_MODEL ?? 'claude-haiku-4-5-20251001'

export type OnpageDimension =
  | 'h1_pattern'
  | 'intro_pattern'
  | 'h2_cadence'
  | 'trust_signal_usage'
  | 'cta_pattern'
  | 'internal_link_style'

export const ONPAGE_DIMENSIONS: ReadonlyArray<OnpageDimension> = [
  'h1_pattern',
  'intro_pattern',
  'h2_cadence',
  'trust_signal_usage',
  'cta_pattern',
  'internal_link_style',
]

/** Human-readable label for each dimension, used in prompts + UI. */
export const DIMENSION_LABELS: Record<OnpageDimension, string> = {
  h1_pattern:          'H1 / Title structure',
  intro_pattern:       'Lead paragraph style',
  h2_cadence:          'Section cadence (H2 count + wording)',
  trust_signal_usage:  'Trust-signal placement',
  cta_pattern:         'Call-to-action style',
  internal_link_style: 'Internal linking style',
}

export interface PageSample {
  /** Full URL or path — used as the source label in extracted memories */
  url:        string
  /** The HTML or markdown body to analyze. Caller is responsible for fetching. */
  content:    string
  /** Optional product name for context (helps the model anchor patterns) */
  productName?: string
}

export interface LearnInput {
  pages:      PageSample[]
  dimensions: OnpageDimension[]    // user picks a subset; empty = use all
  siteSlug:   string
  ownerId:    string
  /**
   * When true, existing on-page memories for the same (site, dimension)
   * are deleted before new ones are inserted. Default false = append.
   */
  replace?:   boolean
}

/** Sprint MIMIR.POLISH.4 — extracted pattern is no longer just a "rule".
 *  Model returns category + content + supporting source URL per pattern. */
export type PatternCategory = 'rule' | 'preference' | 'fact' | 'lesson'

export interface ExtractedPattern {
  category:   PatternCategory
  /** Imperative or descriptive sentence (≤250 chars). */
  content:    string
  /** Verbatim snippet from corpus supporting the pattern. */
  example:    string
  /** First page URL that exhibits the pattern, for trace-back. */
  source_url: string
  /** Count of pages exhibiting the pattern, model-reported (≥2 enforced). */
  page_support: number
}

export interface DimensionResult {
  dimension:    OnpageDimension
  patterns:     ExtractedPattern[] // Sprint MIMIR.POLISH.4 — categorized, not raw strings
  inserted:     number             // memory rows created
  deleted:      number             // memories removed when replace=true
  error?:       string
}

export interface LearnResult {
  ok:               boolean
  total_inserted:   number
  total_deleted:    number
  per_dimension:    DimensionResult[]
  pages_processed:  number
  duration_ms:      number
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Process pages and dimensions sequentially. Designed to be called from a
 * progress-aware endpoint that updates a tracking row as each dimension
 * completes — see /api/mimir/onpage/learn for the wrapper.
 */
export async function learnOnpagePatterns(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:     SupabaseClient<any>,
  input:  LearnInput,
  onProgress?: (done: number, total: number, current: OnpageDimension) => void,
): Promise<LearnResult> {
  const start = Date.now()
  const dimensions = input.dimensions.length > 0 ? input.dimensions : [...ONPAGE_DIMENSIONS]
  const perDim: DimensionResult[] = []

  for (let i = 0; i < dimensions.length; i++) {
    const dim = dimensions[i]
    onProgress?.(i, dimensions.length, dim)

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await learnOneDimension(db, input, dim)
      perDim.push(result)
    } catch (err) {
      perDim.push({
        dimension: dim,
        patterns:  [],
        inserted:  0,
        deleted:   0,
        error:     err instanceof Error ? err.message : String(err),
      })
    }
  }

  onProgress?.(dimensions.length, dimensions.length, dimensions[dimensions.length - 1])

  return {
    ok:               perDim.every(d => !d.error),
    total_inserted:   perDim.reduce((s, d) => s + d.inserted, 0),
    total_deleted:    perDim.reduce((s, d) => s + d.deleted,  0),
    per_dimension:    perDim,
    pages_processed:  input.pages.length,
    duration_ms:      Date.now() - start,
  }
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function learnOneDimension(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:    SupabaseClient<any>,
  input: LearnInput,
  dim:   OnpageDimension,
): Promise<DimensionResult> {
  // 1. Replace mode: clear existing memories for this (owner, site, dim) first.
  let deleted = 0
  if (input.replace) {
    const { data: oldMems, error: delErr } = await db
      .from('mimir_memories')
      .delete()
      .eq('owner_user_id', input.ownerId)
      .eq('site_slug',     input.siteSlug)
      .eq('scope',         'site')
      .contains('tags',    ['onpage', dim])
      .select('id')
    if (delErr) {
      return { dimension: dim, patterns: [], inserted: 0, deleted: 0, error: `delete: ${delErr.message}` }
    }
    deleted = oldMems?.length ?? 0
  }

  // 2. Run extraction with categorized output (Sprint MIMIR.POLISH.4).
  const prompt = buildPrompt(dim, input.pages)
  let patterns: ExtractedPattern[] = []

  try {
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 2000,
      tools:      [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
      messages:   [{ role: 'user', content: prompt }],
    })

    logClaudeUsage(db, input.ownerId, {
      model:       MODEL,
      endpoint:    'mimir_onpage_learn',
      triggeredBy: 'other',
      usage:       res.usage,
      extra:       { dimension: dim, page_count: input.pages.length, site: input.siteSlug },
    })

    const toolUse = res.content.find(c => c.type === 'tool_use')
    if (toolUse && toolUse.type === 'tool_use') {
      const payload = toolUse.input as {
        patterns?: Array<{
          category?:     string
          content?:      string
          example?:      string
          source_url?:   string
          page_support?: number
        }>
      }
      patterns = (payload.patterns ?? [])
        .map(p => {
          const cat = String(p.category ?? '').toLowerCase()
          const validCat: PatternCategory = (
            cat === 'preference' || cat === 'fact' || cat === 'lesson' ? cat : 'rule'
          ) as PatternCategory
          return {
            category:     validCat,
            content:      String(p.content ?? '').trim().slice(0, 250),
            example:      String(p.example ?? '').trim().slice(0, 250),
            source_url:   String(p.source_url ?? '').trim() || (input.pages[0]?.url ?? ''),
            page_support: Math.max(1, Math.min(10, Number(p.page_support ?? 2))),
          }
        })
        .filter(p => p.content)
        // Sprint MIMIR.POLISH.4 — discipline: require ≥2 page support, else drop.
        // Stops single-page quirks from leaking in as rules.
        .filter(p => p.page_support >= 2)
        .slice(0, 6)
    }
  } catch (err) {
    return { dimension: dim, patterns: [], inserted: 0, deleted, error: err instanceof Error ? err.message : String(err) }
  }

  // 3. Insert one memory per pattern with model-chosen category + provenance.
  // Importance defaults differ by category: rules + lessons get 75 (stronger
  // signal), preferences + facts get 60 (softer baseline). Tuner adjusts later.
  const inserts = patterns.map(p => ({
    owner_user_id: input.ownerId,
    scope:         'site' as const,
    site_slug:     input.siteSlug,
    category:      p.category,
    content:       `On-page ${DIMENSION_LABELS[dim]}: ${p.content}`,
    tags:          ['onpage', dim, `support:${p.page_support}p`, p.source_url ? new URL(p.source_url).pathname.split('/').pop()?.slice(0, 40) || 'src' : 'src'].filter(Boolean) as string[],
    importance:    (p.category === 'rule' || p.category === 'lesson') ? 75 : 60,
    pinned:        false,
    source_kind:   'extracted' as const,
    expires_at:    null,
    archived:      false,
  }))

  if (inserts.length === 0) {
    return { dimension: dim, patterns, inserted: 0, deleted }
  }

  const { error: insErr, data: insRows } = await db
    .from('mimir_memories')
    .insert(inserts)
    .select('id')
  if (insErr) {
    return { dimension: dim, patterns, inserted: 0, deleted, error: `insert: ${insErr.message}` }
  }

  return {
    dimension: dim,
    patterns,
    inserted:  insRows?.length ?? 0,
    deleted,
  }
}

function buildPrompt(dim: OnpageDimension, pages: PageSample[]): string {
  const label  = DIMENSION_LABELS[dim]
  const corpus = pages.map((p, i) => {
    const header = p.productName ? `### Page ${i + 1}: ${p.productName} (${p.url})` : `### Page ${i + 1}: ${p.url}`
    // Truncate each page to ~4000 chars to keep token cost reasonable
    const body = p.content.length > 4000 ? p.content.slice(0, 4000) + '\n…[truncated]' : p.content
    return `${header}\n${body}`
  }).join('\n\n---\n\n')

  return `You are analyzing real published SEO pages from G2G.com to learn the team's house style for one specific dimension: **${label}**.

DIMENSION: ${label}
WHAT TO LOOK FOR:
${DIMENSION_HINTS[dim]}

CLASSIFY EACH PATTERN STRICTLY (Sprint MIMIR.POLISH.4):

• "rule" — Absolute pattern enforced across ALL or NEARLY ALL pages (≥3 of ${pages.length}). Phrased as "always" or "never". Example: "Always place H1 within first 50 words" or "Never use 'embark' or 'immersive'". This is the MOST RESTRICTIVE category — use sparingly.

• "preference" — Soft tendency observable in ≥2 pages but with variation. Phrased as "tend to" or "prefer". Example: "Tend to open intro with a benefit statement rather than a question". Most stylistic observations belong here, NOT in rule.

• "fact" — Descriptive statement about the brand or product that is true but is NOT a directive. Example: "Trust signals include GamerProtect, ISO certification, escrow" or "Average H2 count is 6". Use when content describes what IS rather than what TO DO.

• "lesson" — Past mistake that was corrected. RARELY produced by on-page analysis (lessons usually come from team edits, not from reading published pages). Only use if you can identify a clear "before/after" pattern, like "Older pages used X, newer pages corrected to Y".

DEFAULT TO PREFERENCE when uncertain. Rules are reserved for true absolutes that copywriters MUST follow. Most observed patterns are preferences.

INSTRUCTIONS:
1. Read all ${pages.length} pages below.
2. Identify 2-6 patterns. For each, decide which category fits BEST per definitions above.
3. Record page_support = number of pages exhibiting the pattern (must be ≥2; single-page quirks are dropped).
4. Pick ONE source_url from a page that clearly exhibits the pattern.
5. Capture a short verbatim example (≤250 chars) from the corpus.
6. Patterns must be specific enough to be actionable. Avoid vague observations like "good content has clear structure".

CORPUS (${pages.length} pages):
${corpus}

Call the submit_patterns tool with your findings.`
}

const DIMENSION_HINTS: Record<OnpageDimension, string> = {
  h1_pattern:
    '• Where does the primary keyword appear in the H1? (start, middle, end)\n• Typical H1 length in words?\n• Format: "{Keyword} — {benefit}" vs "Buy {Keyword}" vs "{Keyword} Guide"?',
  intro_pattern:
    '• Length of the lead paragraph (words/sentences)?\n• Does it open with a question, a benefit, a stat, the brand?\n• How quickly does the keyword appear (sentence 1, 2, 3)?',
  h2_cadence:
    '• How many H2 sections do typical pages have?\n• Recurring H2 themes (e.g. "Why buy X", "How to redeem", "FAQ")?\n• Are FAQs always last? Always a section?',
  trust_signal_usage:
    '• Where do trust signals appear: GamerProtect, ISO 27001, 200+ payments, 24/7 support?\n• Are they in a dedicated section, inline in copy, or both?\n• Do they appear early (above the fold) or late (after marketing)?',
  cta_pattern:
    '• Style: imperative ("Buy now"), benefit-led ("Save 20%"), brand-led ("Shop on G2G")?\n• Frequency: once at the top, multiple inline, end of every section?\n• Anchor text vs button copy?',
  internal_link_style:
    '• Where do internal links go (categories, related products, blog, FAQ)?\n• Anchor text style: keyword-exact vs descriptive vs branded?\n• Approximate link density (links per 100 words)?',
}

// Sprint MIMIR.POLISH.4 — extract tool now requires categorized output per
// pattern with explicit page_support count + source URL for trace-back.
const EXTRACT_TOOL = {
  name: 'submit_patterns',
  description: 'Submit categorized patterns observed across the corpus for this dimension. Each pattern includes category, content, example snippet, source URL, and page support count.',
  input_schema: {
    type: 'object' as const,
    required: ['patterns'],
    properties: {
      patterns: {
        type:        'array',
        description: '2-6 categorized patterns. Default to "preference" for stylistic observations; reserve "rule" for absolutes observed across nearly all pages.',
        items: {
          type:     'object',
          required: ['category', 'content', 'example', 'source_url', 'page_support'],
          properties: {
            category: {
              type:        'string',
              enum:        ['rule', 'preference', 'fact', 'lesson'],
              description: 'Strict classification per definitions. Default to preference when uncertain.',
            },
            content: {
              type:        'string',
              maxLength:   250,
              description: 'Pattern statement. For rules/preferences use imperative phrasing; for facts use descriptive.',
            },
            example: {
              type:        'string',
              maxLength:   250,
              description: 'Verbatim snippet from the corpus that demonstrates the pattern.',
            },
            source_url: {
              type:        'string',
              description: 'URL of one page that clearly exhibits this pattern (for trace-back).',
            },
            page_support: {
              type:        'integer',
              minimum:     2,
              description: 'Number of pages exhibiting this pattern (must be ≥2; single-page quirks are dropped).',
            },
          },
        },
        maxItems:    6,
      },
    },
  },
}
