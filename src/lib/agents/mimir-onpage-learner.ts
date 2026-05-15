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
// Each extracted pattern becomes one mimir_memories row with:
//   category   = 'rule'
//   scope      = 'site'
//   tags       = ['onpage', dimension, ...]
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

export interface DimensionResult {
  dimension:    OnpageDimension
  patterns:     string[]        // 2-5 short rules extracted from the cohort
  examples:     string[]        // verbatim snippets supporting each pattern
  inserted:     number          // memory rows created
  deleted:      number          // memories removed when replace=true
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
        examples:  [],
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
      return { dimension: dim, patterns: [], examples: [], inserted: 0, deleted: 0, error: `delete: ${delErr.message}` }
    }
    deleted = oldMems?.length ?? 0
  }

  // 2. Run extraction
  const prompt = buildPrompt(dim, input.pages)
  let extracted: { patterns: string[]; examples: string[] } = { patterns: [], examples: [] }

  try {
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 1500,
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
      const payload = toolUse.input as { patterns?: string[]; examples?: string[] }
      extracted = {
        patterns: (payload.patterns ?? []).map(p => String(p ?? '').trim()).filter(Boolean).slice(0, 5),
        examples: (payload.examples ?? []).map(p => String(p ?? '').trim()).filter(Boolean).slice(0, 5),
      }
    }
  } catch (err) {
    return { dimension: dim, patterns: [], examples: [], inserted: 0, deleted, error: err instanceof Error ? err.message : String(err) }
  }

  // 3. Insert one memory per pattern.
  const inserts = extracted.patterns.map((pattern, idx) => ({
    owner_user_id: input.ownerId,
    scope:         'site' as const,
    site_slug:     input.siteSlug,
    category:      'rule' as const,
    content:       `On-page ${DIMENSION_LABELS[dim]}: ${pattern}`,
    tags:          ['onpage', dim],
    importance:    70,
    pinned:        false,
    source_kind:   'extracted' as const,
    expires_at:    null,
    archived:      false,
  })).slice(0, 5)

  if (inserts.length === 0) {
    return { dimension: dim, patterns: extracted.patterns, examples: extracted.examples, inserted: 0, deleted }
  }

  const { error: insErr, data: insRows } = await db
    .from('mimir_memories')
    .insert(inserts)
    .select('id')
  if (insErr) {
    return { dimension: dim, patterns: extracted.patterns, examples: extracted.examples, inserted: 0, deleted, error: `insert: ${insErr.message}` }
  }

  return {
    dimension: dim,
    patterns:  extracted.patterns,
    examples:  extracted.examples,
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

INSTRUCTIONS:
1. Read all ${pages.length} pages below.
2. Identify 2-5 RECURRING patterns specific to ${label}. Pattern = a rule observable in multiple pages, not a quirk of one.
3. For each pattern, capture a short verbatim example from the corpus that demonstrates it.
4. Write patterns as imperative rules for a copywriter to follow: "Start the H1 with…", "Place the trust signal after the second H2…", etc.
5. Ignore patterns from a SINGLE page. Need at least 2 supporting examples to count as a pattern.

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

const EXTRACT_TOOL = {
  name: 'submit_patterns',
  description: 'Submit the patterns observed across the corpus for this dimension.',
  input_schema: {
    type: 'object' as const,
    required: ['patterns', 'examples'],
    properties: {
      patterns: {
        type:        'array',
        description: '2-5 imperative rules describing the recurring on-page pattern for this dimension.',
        items:       { type: 'string', maxLength: 250 },
        maxItems:    5,
      },
      examples: {
        type:        'array',
        description: 'Short verbatim snippets from the corpus that demonstrate the patterns.',
        items:       { type: 'string', maxLength: 250 },
        maxItems:    5,
      },
    },
  },
}
