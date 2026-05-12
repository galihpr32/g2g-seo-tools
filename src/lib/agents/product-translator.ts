import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logClaudeUsage } from '@/lib/api-logger'

/**
 * Translate the structured product-content bundle from English to Bahasa
 * Indonesian. Used by the sheet-as-database flow:
 *   • EN generator produces 8 marketing_sections (HTML) + 5-7 FAQ Q/A pairs
 *   • This translator preserves the same structure 1:1 in ID
 *   • Output written to the "ID" sheet tab + DB id_* columns
 *
 * Translation rules baked in: keep gaming proper nouns + brand terms in
 * English, preserve HTML tags, use "kamu" (informal you).
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

export interface ProductContentBundle {
  metaTitle:          string
  metaDescription:    string
  metaKeyword:        string                          // comma-separated string
  marketingTitle:     string                          // H1
  marketingIntro:     string                          // Lead paragraph after H1, before sections
  marketingSections:  string[]                        // length 8 (HTML)
  faqs:               Array<{ q: string; a: string }> // length 5-7
}

export interface TranslateInput {
  productName:  string
  category:     string
  mainKeyword:  string
  english:      ProductContentBundle
}

export interface TranslateResult {
  ok:     boolean
  bundle?: ProductContentBundle
  error?: string
  usage?: { inputTokens: number; outputTokens: number }
}

function buildPrompt(input: TranslateInput): string {
  return `You are translating SEO product content from English to Bahasa Indonesia for G2G.com — an Indonesian-friendly gaming marketplace.

PRODUCT: ${input.productName}
CATEGORY: ${input.category}
PRIMARY KEYWORD (English, keep as proper noun): ${input.mainKeyword}

TRANSLATION RULES:
1. Keep the structure identical: same marketing_intro lead paragraph, same 8 marketing_sections, same number of FAQs (${input.english.faqs.length}).
2. Keep gaming proper nouns / brand terms in English: "WoW Gold", "Diablo Items", "PSN Card", "Steam Wallet", game titles.
3. Keep the primary keyword IN meta_title and meta_description (Indonesian users search the English brand term).
4. meta_description: keep under 160 characters. Natural Indonesian, not stiff word-for-word.
5. marketing_intro: 40-60 word lead paragraph, plain prose, NO HTML tags.
6. marketing_sections: PRESERVE all HTML tags (<h2>, <p>, <ul>, <li>, <strong>, <ol>, <a>) intact. Only translate the text inside tags.
7. faqs: translate question + answer naturally. Keep brand terms English.
8. Currency / price formatting: leave any USD or numeric values exactly as-is.
9. Tone: friendly + trustworthy. Use "kamu" (informal you), not "Anda" — matches the gaming audience.

ENGLISH SOURCE:
${JSON.stringify({
  meta_title:          input.english.metaTitle,
  meta_description:    input.english.metaDescription,
  meta_keyword:        input.english.metaKeyword,
  marketing_title:     input.english.marketingTitle,
  marketing_intro:     input.english.marketingIntro,
  marketing_sections:  input.english.marketingSections,
  faqs:                input.english.faqs,
}, null, 2)}

Call the submit_translation tool with the translated fields. Same structure as English — same field names, ID content.`
}

// Tool schema — using tool_use eliminates parse errors caused by unescaped
// quotes in nested HTML content within a JSON string.
const TRANSLATION_TOOL = {
  name: 'submit_translation',
  description: 'Submit the Indonesian translation as structured data.',
  input_schema: {
    type: 'object' as const,
    required: ['meta_title', 'meta_description', 'meta_keyword', 'marketing_title', 'marketing_intro', 'marketing_sections', 'faqs'],
    properties: {
      meta_title:       { type: 'string' },
      meta_description: { type: 'string' },
      meta_keyword:     { type: 'string' },
      marketing_title:  { type: 'string', description: 'H1 text in Bahasa Indonesia (no <h1> tags — caller wraps).' },
      marketing_intro:  { type: 'string', description: 'Lead paragraph in plain ID prose, 40-60 words, no HTML.' },
      marketing_sections: {
        type: 'array',
        items:    { type: 'string', description: '<h2 class="text-h5 q-ma-none">…</h2>… body … <br><br>' },
        minItems: 8,
        maxItems: 8,
      },
      faqs: {
        type: 'array',
        items: {
          type: 'object',
          required: ['q', 'a'],
          properties: { q: { type: 'string' }, a: { type: 'string' } },
        },
        minItems: 5,
        maxItems: 7,
      },
    },
  },
}

export async function translateProductContent(
  input: TranslateInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?:      SupabaseClient<any, any, any>,
  ownerId?: string,
): Promise<TranslateResult> {
  try {
    const prompt = buildPrompt(input)
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 8192,
      tools:      [TRANSLATION_TOOL],
      tool_choice: { type: 'tool', name: TRANSLATION_TOOL.name },
      messages:   [{ role: 'user', content: prompt }],
    })

    if (db && ownerId) {
      logClaudeUsage(db, ownerId, {
        model:       MODEL,
        endpoint:    'product_translate_id',
        triggeredBy: 'other',
        usage:       res.usage,
        extra:       { product_name: input.productName },
      })
    }

    const toolUseBlock = res.content.find(c => c.type === 'tool_use')
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      return { ok: false, error: 'Translation AI did not call the submit_translation tool' }
    }

    const parsed = toolUseBlock.input as Record<string, unknown>

    if (typeof parsed.meta_title         !== 'string') return { ok: false, error: 'translation missing meta_title' }
    if (typeof parsed.meta_description   !== 'string') return { ok: false, error: 'translation missing meta_description' }
    if (typeof parsed.marketing_title    !== 'string') return { ok: false, error: 'translation missing marketing_title' }
    if (!Array.isArray(parsed.marketing_sections))     return { ok: false, error: 'translation missing marketing_sections array' }
    if (!Array.isArray(parsed.faqs))                   return { ok: false, error: 'translation missing faqs array' }

    const sections = (parsed.marketing_sections as unknown[]).map(s => String(s ?? ''))
    while (sections.length < 8) sections.push('')

    const faqs = (parsed.faqs as unknown[]).map(f => {
      const obj = f as Record<string, unknown>
      return { q: String(obj.q ?? ''), a: String(obj.a ?? '') }
    }).filter(f => f.q && f.a)

    return {
      ok: true,
      bundle: {
        metaTitle:         String(parsed.meta_title),
        metaDescription:   String(parsed.meta_description),
        metaKeyword:       String(parsed.meta_keyword ?? ''),
        marketingTitle:    String(parsed.marketing_title),
        marketingIntro:    String(parsed.marketing_intro ?? ''),
        marketingSections: sections.slice(0, 8),
        faqs,
      },
      usage: {
        inputTokens:  res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      },
    }
  } catch (err) {
    return {
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
