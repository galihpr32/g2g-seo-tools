// ─── AI Overview fan-out generator ─────────────────────────────────────────
//
// Sprint CKB.2 — Given a primary commercial KW, generate 12 sub-queries
// that an AI Overview / Gemini Search would fan out to answer the topic.
// Output is structured: each entry has both EN and ID translations + a
// suggested section to drop into on the product page.
//
// This is the AEO/GEO (Answer/Generative Engine Optimization) component:
// every passage produced from these sub-queries is a citation-ready block
// for LLM-driven search.

import Anthropic from '@anthropic-ai/sdk'
import type { KitFanOutPassage } from './types'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface FanOutInput {
  primaryKeyword:   string
  productName:      string
  category?:        string
  market:           'us' | 'id'
  /** How many passages to generate. Default 10, cap 16. */
  targetCount?:     number
}

export interface FanOutResult {
  passages:        KitFanOutPassage[]
  ai_call_cost:    number     // USD estimate
}

const FALLBACK: KitFanOutPassage[] = [
  {
    topic:        'Delivery speed',
    passage_en:   'Most orders complete within 5-15 minutes. Faster delivery costs more but the cheap tier still arrives within the same business day.',
    passage_id:   'Sebagian besar pesanan selesai dalam 5-15 menit. Pengiriman tercepat lebih mahal tapi tier murah pun tetap sampai dalam hari yang sama.',
    section_hint: 'How delivery works',
  },
  {
    topic:        'Payment safety',
    passage_en:   'Secure payment methods include PayPal, credit card, and regional e-wallets. Buyer protection is included on every order.',
    passage_id:   'Metode pembayaran aman meliputi PayPal, kartu kredit, dan e-wallet lokal. Perlindungan pembeli tersedia untuk setiap pesanan.',
    section_hint: 'FAQ',
  },
]

/**
 * Generate fan-out passages via Haiku. Falls back to a 2-item generic set
 * if ANTHROPIC_API_KEY is missing — the kit builder still completes so the
 * dev/staging environment doesn't break without a real API key.
 */
export async function generateFanOutPassages(input: FanOutInput): Promise<FanOutResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { passages: FALLBACK, ai_call_cost: 0 }
  }
  const anthropic = new Anthropic({ apiKey })
  const target = Math.min(input.targetCount ?? 10, 16)

  const prompt = `You're producing AI Overview-style answer passages for a product page on G2G.com (gaming marketplace).

Primary keyword: "${input.primaryKeyword}"
Product: ${input.productName}
${input.category ? `Category: ${input.category}` : ''}
Market: ${input.market === 'us' ? 'Global English-speaking' : 'Indonesia (Bahasa Indonesia)'}

Generate ${target} short answer passages. Each passage should:
1. Address a sub-query an AI Overview (Gemini Search, ChatGPT browse, Perplexity) might fire when answering "${input.primaryKeyword}"
2. Be 50-80 words in English
3. Have an Indonesian translation that conveys the same meaning naturally
4. Be citation-worthy: factual, neutral, marketplace-relevant (NOT promotional fluff)
5. Bias toward commercial intent — never recommend DIY/farming-yourself approaches that would make the user NOT buy from us

Cover a mix of:
- Delivery / fulfillment details
- Payment methods / safety / refunds
- Comparison to alternatives (buying vs farming, value tiers)
- Platform compatibility (PC / console / mobile cross-play)
- Best practices for ordering (timing, package size, league/season relevance)
- Account safety / ban risk / trustworthiness

Output ONLY a JSON array of ${target} objects with this exact shape (no prose, no markdown):
[
  {
    "topic": "<short label, 2-4 words>",
    "passage_en": "<50-80 word answer>",
    "passage_id": "<Indonesian translation, natural Bahasa>",
    "section_hint": "<which H2 section this fits: 'How delivery works' | 'Payment & safety' | 'Buying vs farming' | 'Cross-platform' | 'FAQ' | 'Best packages'>"
  }
]`

  try {
    const res = await anthropic.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  3000,
      temperature: 0.5,
      messages:    [{ role: 'user', content: prompt }],
    })
    const text = res.content.find(c => c.type === 'text')?.text ?? '[]'
    const match = text.match(/\[[\s\S]*\]/)
    const parsed = match ? JSON.parse(match[0]) as KitFanOutPassage[] : []
    const passages = parsed
      .slice(0, target)
      .map(p => ({
        topic:        String(p.topic ?? '').slice(0, 60),
        passage_en:   String(p.passage_en ?? '').slice(0, 600),
        passage_id:   String(p.passage_id ?? '').slice(0, 700),
        section_hint: String(p.section_hint ?? 'FAQ').slice(0, 40),
      }))
      .filter(p => p.passage_en.length > 30 && p.passage_id.length > 30)

    // Rough cost: ~3000 in + 2500 out tokens × Haiku pricing ≈ $0.012
    return { passages: passages.length > 0 ? passages : FALLBACK, ai_call_cost: 0.012 }
  } catch (err) {
    console.warn('[content-kit fan-out] Haiku failed, using fallback:', err instanceof Error ? err.message : String(err))
    return { passages: FALLBACK, ai_call_cost: 0 }
  }
}
