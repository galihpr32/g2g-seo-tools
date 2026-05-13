// ─── Haiku-powered keyword extractor for news articles ─────────────────────
// Pulls 3-5 substantive topic phrases out of an article. Phrases are
// multi-word and concrete ("Path of Exile 2 endgame builds", not "path" /
// "exile" / "2") so they're directly usable as keyword candidates.
//
// Relevance bucket assigned per phrase:
//   - high    → matches a tier product OR contains commercial intent terms
//   - medium  → matches a catalog brand_name (G2G product exists, not tiered)
//   - low     → gaming-related general
//
// Idempotent: skips articles where `keywords_extracted_at IS NOT NULL`.
// Batched: up to N articles per run, sequential Haiku calls (cheap enough).

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001'

export type Relevance = 'high' | 'medium' | 'low'

export interface ExtractedKeyword {
  phrase:    string
  relevance: Relevance
}

export interface ExtractionRun {
  scanned:   number    // total articles considered
  extracted: number    // articles that got new keywords
  skipped:   number    // already had keywords (idempotent skip)
  failed:    number
  errors:    string[]
}

interface NewsItemForExtraction {
  id:          string
  title:       string
  excerpt:     string | null
  scraped_md:  string | null
}

/**
 * Run extraction for articles in the lookback window that don't yet have
 * keywords. Updates `news_items.extracted_keywords` + `keywords_extracted_at`.
 *
 * @param maxBatch — cap concurrent extractions to avoid blowing through
 *                   Vercel function time / Haiku rate limits. Default 50.
 */
export async function extractKeywordsForOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  args: {
    days?:           number      // lookback window — default 14
    maxBatch?:       number      // default 50
    /** When true, re-extract even if already done. Use after a prompt tweak. */
    force?:          boolean
    /** Tier product brand names + catalog brand names — used for relevance scoring. */
    tierProductNames?:   string[]
    catalogBrandNames?:  string[]
  } = {},
): Promise<ExtractionRun> {
  const days      = args.days      ?? 14
  const maxBatch  = args.maxBatch  ?? 50
  const sinceIso  = new Date(Date.now() - days * 86_400_000).toISOString()

  let query = db
    .from('news_items')
    .select('id, title, excerpt, scraped_md')
    .eq('owner_user_id', ownerId)
    .gte('fetched_at', sinceIso)
    .order('published_at', { ascending: false })
    .limit(maxBatch)

  if (!args.force) query = query.is('keywords_extracted_at', null)

  const { data: items, error } = await query
  if (error) return { scanned: 0, extracted: 0, skipped: 0, failed: 0, errors: [error.message] }

  const candidates = (items ?? []) as NewsItemForExtraction[]
  if (candidates.length === 0) {
    return { scanned: 0, extracted: 0, skipped: 0, failed: 0, errors: [] }
  }

  // Lowercase sets for fast relevance scoring (no LLM round-trip needed for tier/catalog match)
  const tierNamesLc    = new Set((args.tierProductNames  ?? []).map(n => n.toLowerCase()))
  const catalogNamesLc = new Set((args.catalogBrandNames ?? []).map(n => n.toLowerCase()))

  const result: ExtractionRun = { scanned: candidates.length, extracted: 0, skipped: 0, failed: 0, errors: [] }
  const now = new Date().toISOString()

  for (const item of candidates) {
    try {
      const keywords = await extractFromOneArticle(item)
      if (keywords.length === 0) {
        // Mark as done even if no keywords — prevents infinite retries
        await db.from('news_items')
          .update({ extracted_keywords: [], keywords_extracted_at: now })
          .eq('id', item.id)
        result.skipped++
        continue
      }

      // Score relevance deterministically using tier + catalog sets
      const scored: ExtractedKeyword[] = keywords.map(kw => ({
        phrase:    kw,
        relevance: scoreRelevance(kw, tierNamesLc, catalogNamesLc),
      }))

      await db.from('news_items')
        .update({
          extracted_keywords:    scored,
          keywords_extracted_at: now,
        })
        .eq('id', item.id)

      result.extracted++
    } catch (e) {
      result.failed++
      result.errors.push(`${item.id}: ${e instanceof Error ? e.message : String(e)}`)
      // Still stamp so we don't retry forever
      await db.from('news_items')
        .update({ keywords_extracted_at: now })
        .eq('id', item.id)
    }
  }

  return result
}

// ─── Single-article extraction ────────────────────────────────────────────

async function extractFromOneArticle(item: NewsItemForExtraction): Promise<string[]> {
  // Trim article text to keep Haiku call cheap. Title + excerpt + first 1500
  // chars of scraped body is enough for topic extraction.
  const corpus = [
    `TITLE: ${item.title}`,
    item.excerpt    ? `EXCERPT: ${item.excerpt}` : '',
    item.scraped_md ? `BODY (truncated): ${item.scraped_md.slice(0, 1500)}` : '',
  ].filter(Boolean).join('\n\n')

  if (corpus.length < 50) return []   // too thin to extract from

  const resp = await anthropic.messages.create({
    model: EXTRACTOR_MODEL,
    max_tokens: 512,
    tool_choice: { type: 'tool', name: 'submit_keywords' },
    tools: [{
      name: 'submit_keywords',
      description: 'Return the 3-5 most substantive topic keyword PHRASES from this gaming news article.',
      input_schema: {
        type: 'object',
        properties: {
          phrases: {
            type: 'array',
            items: { type: 'string' },
            minItems: 0,
            maxItems: 6,
            description: 'Multi-word keyword phrases (2-5 words each), gaming-relevant, suitable as SEO keyword candidates. NOT single common words. NOT the article author or publisher name.',
          },
        },
        required: ['phrases'],
      },
    }],
    messages: [{
      role: 'user',
      content: `Extract 3-5 substantive topic KEYWORD PHRASES from this gaming news article. Rules:
- Phrases must be 2-5 words. Single words ("Genshin") are too generic — prefer "Genshin Impact 5.2 banner".
- Must be gaming-relevant. Skip publisher/author names, generic verbs.
- Lowercase the output. Punctuation only if part of the phrase ("call of duty: warzone").
- Prefer specific (game title + feature/event) over generic (game title alone).
- If the article is not gaming-related at all, return an empty array.

ARTICLE:
${corpus}`,
    }],
  })

  const block = resp.content.find(c => c.type === 'tool_use')
  if (!block || block.type !== 'tool_use') return []
  const input = block.input as { phrases?: unknown }
  if (!Array.isArray(input.phrases)) return []

  return input.phrases
    .map(p => String(p ?? '').trim().toLowerCase())
    .filter(p => p.length >= 4 && p.length <= 80)
    .slice(0, 5)
}

// ─── Relevance scoring (no LLM) ───────────────────────────────────────────

function scoreRelevance(
  phrase:       string,
  tierNamesLc:  Set<string>,
  catalogLc:    Set<string>,
): Relevance {
  const lc = phrase.toLowerCase()

  // High: phrase contains any tier product brand name
  for (const name of tierNamesLc) {
    if (lc.includes(name)) return 'high'
  }

  // Medium: phrase contains any catalog brand name (G2G has a product, not tiered)
  for (const name of catalogLc) {
    if (lc.includes(name)) return 'medium'
  }

  // Low: gaming-related but not a known brand
  return 'low'
}

/**
 * Format keywords for export cell. Optionally filter by relevance threshold.
 * Renders as newline-separated bullets for Sheets readability.
 */
export function formatKeywordsForCell(
  keywords: ExtractedKeyword[] | null | undefined,
  minRelevance?: Relevance,
): string {
  if (!keywords || keywords.length === 0) return ''

  const filtered = minRelevance
    ? keywords.filter(k => relevanceRank(k.relevance) >= relevanceRank(minRelevance))
    : keywords

  return filtered
    .sort((a, b) => relevanceRank(b.relevance) - relevanceRank(a.relevance))
    .slice(0, 5)
    .map(k => `• ${k.phrase}${k.relevance === 'high' ? ' 🟢' : k.relevance === 'medium' ? ' 🟡' : ''}`)
    .join('\n')
}

function relevanceRank(r: Relevance): number {
  return r === 'high' ? 3 : r === 'medium' ? 2 : 1
}
