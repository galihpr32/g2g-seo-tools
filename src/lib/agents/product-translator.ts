import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logClaudeUsage } from '@/lib/api-logger'

/**
 * Translate the parsed product-content JSON from English to Indonesian.
 *
 * The auto-content sync generates the EN version first (Sonnet/Haiku writing
 * to G2G's brand voice in English). We then translate the same factual
 * content to Bahasa Indonesia for the marketplace's ID storefront. Same
 * SEO terms (keywords, prices, brand names) stay in English where they're
 * proper nouns — Claude is briefed on this so we don't end up with weird
 * "permainan" instead of "game" type translations.
 *
 * Shape mirrors what the EN generator returns so callers can plug it in
 * directly.
 */

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

export interface ProductContentBundle {
  meta_title:            string
  meta_description:      string
  meta_keywords:         string
  marketing_title:       string
  marketing_description: string   // HTML
}

export interface TranslateInput {
  productName:  string
  category:     string
  mainKeyword:  string
  english:      ProductContentBundle
}

export interface TranslateResult {
  ok:        boolean
  bundle?:   ProductContentBundle
  error?:    string
  /** Token usage for cost auditing. */
  usage?:    { inputTokens: number; outputTokens: number }
}

const PROMPT_TEMPLATE = (input: TranslateInput) => `You are translating SEO product content from English to Bahasa Indonesia for G2G.com — an Indonesian-friendly gaming marketplace.

PRODUCT: ${input.productName}
CATEGORY: ${input.category}
PRIMARY KEYWORD (English, keep as proper noun): ${input.mainKeyword}

TRANSLATION RULES:
1. Keep the structure: meta_title, meta_description, meta_keywords, marketing_title, marketing_description.
2. Keep gaming proper nouns / brand terms in English: "WoW Gold", "Diablo Items", "PSN Card", "Steam Wallet", etc.
3. Keep the primary keyword IN the meta_title and meta_description (Indonesian users search the English brand term).
4. meta_description: keep under 160 characters. Use natural Indonesian, not stiff word-for-word.
5. marketing_description: preserve any HTML tags (<p>, <h2>, <ul>, <li>, <strong>) intact — only translate the text inside.
6. Currency / price formatting: leave any USD or numeric values exactly as-is.
7. Tone: friendly + trustworthy. Use "kamu" (informal you), not "Anda" — matches the gaming audience.

ENGLISH SOURCE:
{
  "meta_title":            ${JSON.stringify(input.english.meta_title)},
  "meta_description":      ${JSON.stringify(input.english.meta_description)},
  "meta_keywords":         ${JSON.stringify(input.english.meta_keywords)},
  "marketing_title":       ${JSON.stringify(input.english.marketing_title)},
  "marketing_description": ${JSON.stringify(input.english.marketing_description)}
}

Return ONLY a JSON object (no markdown fences, no commentary):
{
  "meta_title":            "...",
  "meta_description":      "...",
  "meta_keywords":         "...",
  "marketing_title":       "...",
  "marketing_description": "..."
}`

export async function translateProductContent(
  input: TranslateInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db?:      SupabaseClient<any, any, any>,
  ownerId?: string,
): Promise<TranslateResult> {
  try {
    const prompt = PROMPT_TEMPLATE(input)
    const res = await anthropic.messages.create({
      model:      MODEL,
      max_tokens: 4096,
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

    const text = res.content[0]?.type === 'text' ? res.content[0].text.trim() : '{}'
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim()
    const parsed = JSON.parse(jsonStr)

    // Sanity check — all 5 fields must be present
    const required = ['meta_title', 'meta_description', 'meta_keywords', 'marketing_title', 'marketing_description']
    for (const field of required) {
      if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
        return { ok: false, error: `Missing or empty field "${field}" in translation response` }
      }
    }

    return {
      ok:     true,
      bundle: {
        meta_title:            String(parsed.meta_title),
        meta_description:      String(parsed.meta_description),
        meta_keywords:         String(parsed.meta_keywords),
        marketing_title:       String(parsed.marketing_title),
        marketing_description: String(parsed.marketing_description),
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
