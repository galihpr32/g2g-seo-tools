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
  marketingTitle:     string
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
1. Keep the structure identical: same 8 marketing_sections, same number of FAQs (${input.english.faqs.length}).
2. Keep gaming proper nouns / brand terms in English: "WoW Gold", "Diablo Items", "PSN Card", "Steam Wallet", game titles.
3. Keep the primary keyword IN meta_title and meta_description (Indonesian users search the English brand term).
4. meta_description: keep under 160 characters. Natural Indonesian, not stiff word-for-word.
5. marketing_sections: PRESERVE all HTML tags (<h2>, <p>, <ul>, <li>, <strong>, <ol>, <a>) intact. Only translate the text inside tags.
6. faqs: translate question + answer naturally. Keep brand terms English.
7. Currency / price formatting: leave any USD or numeric values exactly as-is.
8. Tone: friendly + trustworthy. Use "kamu" (informal you), not "Anda" — matches the gaming audience.

ENGLISH SOURCE:
${JSON.stringify({
  meta_title:          input.english.metaTitle,
  meta_description:    input.english.metaDescription,
  meta_keyword:        input.english.metaKeyword,
  marketing_title:     input.english.marketingTitle,
  marketing_sections:  input.english.marketingSections,
  faqs:                input.english.faqs,
}, null, 2)}

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{
  "meta_title":         "...",
  "meta_description":   "...",
  "meta_keyword":       "...",
  "marketing_title":    "...",
  "marketing_sections": [ "<h2>...</h2><p>...</p>", "...", "...", "...", "...", "...", "...", "..." ],
  "faqs": [
    { "q": "...", "a": "..." }
    /* ${input.english.faqs.length} entries total */
  ]
}`
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
      max_tokens: 8192,   // structured content with 8 sections + FAQs takes more tokens than the old flat blob
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

    const text    = res.content[0]?.type === 'text' ? res.content[0].text.trim() : '{}'
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed  = JSON.parse(jsonStr) as Record<string, unknown>

    // Structural validation — protect downstream code from partial outputs.
    if (typeof parsed.meta_title         !== 'string') return { ok: false, error: 'translation missing meta_title' }
    if (typeof parsed.meta_description   !== 'string') return { ok: false, error: 'translation missing meta_description' }
    if (typeof parsed.marketing_title    !== 'string') return { ok: false, error: 'translation missing marketing_title' }
    if (!Array.isArray(parsed.marketing_sections))     return { ok: false, error: 'translation missing marketing_sections array' }
    if (!Array.isArray(parsed.faqs))                   return { ok: false, error: 'translation missing faqs array' }

    const sections = (parsed.marketing_sections as unknown[]).map(s => String(s ?? ''))
    while (sections.length < 8) sections.push('')   // pad

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
