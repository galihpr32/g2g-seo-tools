// ─── H2 heading polisher (Haiku) ───────────────────────────────────────────
//
// Sprint CKB.REL.1 — Takes draft H2 headings + supporting KWs + intent class
// per section, returns polished natural-sounding headings.
//
// Why this exists: deterministic template-based heading generation produces
// awkward repeats ("Cheap X Packages" for 5 different KWs that all share the
// word "cheap"). Sending all headings to Haiku in ONE batch call (single
// $0.005 call total, not per-heading) gives natural variation without
// blowing up cost.

import Anthropic from '@anthropic-ai/sdk'
import type { IntentClass, Market } from './types'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface DraftHeading {
  target_kw:    string
  intent_class: IntentClass
  draft:        string         // template-based fallback if Haiku fails
}

export interface PolishOptions {
  productName: string
  market:      Market
}

export interface PolishResult {
  headings:     string[]       // 1:1 with input order
  ai_call_cost: number
}

/**
 * Polish many H2 headings in a single Haiku call. Returns drafts unchanged
 * if API key missing or call fails.
 */
export async function polishHeadings(
  drafts: DraftHeading[],
  opts: PolishOptions,
): Promise<PolishResult> {
  if (drafts.length === 0) {
    return { headings: [], ai_call_cost: 0 }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { headings: drafts.map(d => d.draft), ai_call_cost: 0 }
  }
  const anthropic = new Anthropic({ apiKey })

  const marketLabel = opts.market === 'id' ? 'Indonesia (Bahasa, but use English unless KW is Indonesian)' : 'Global English-speaking'

  const prompt = `You're polishing H2 section headings for a G2G marketplace product page.

Product: ${opts.productName}
Target market: ${marketLabel}
Page rule: every H2 must reflect commercial intent — visitor lands on this product page because they want to BUY (not learn).

For each draft below, rewrite the H2 to:
1. Be natural and specific (NOT repetitive across sections — vary phrasing)
2. 4-8 words max
3. Include the target keyword OR a close variant (keep brand+product names intact)
4. Reflect the intent class:
   - commercial-supportive: direct, transactional ("Cheap BNS Gold Online", "BNS Gold Fast Delivery")
   - commercial-investigation: comparison angle ("BNS Gold Sellers Compared", "Buying vs Trading BNS Gold")
   - diy-competing: counter-frame why buying beats DIY ("BNS Gold Farming Time Cost", "Skip the Grind for BNS Gold")
5. NEVER start two consecutive H2s the same way ("Cheap...", "Cheap...", "Cheap..." is WRONG)

Drafts (${drafts.length} sections):
${drafts.map((d, i) => `[${i + 1}] Target KW: "${d.target_kw}" · Intent: ${d.intent_class} · Draft: "${d.draft}"`).join('\n')}

Output ONLY a JSON array of ${drafts.length} polished heading strings in the same order. No prose, no markdown.
Example: ["First heading", "Second heading", "Third heading"]`

  try {
    const res = await anthropic.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  500,
      temperature: 0.5,
      messages:    [{ role: 'user', content: prompt }],
    })
    const text = res.content.find(c => c.type === 'text')?.text ?? '[]'
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) {
      return { headings: drafts.map(d => d.draft), ai_call_cost: 0.005 }
    }
    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) {
      return { headings: drafts.map(d => d.draft), ai_call_cost: 0.005 }
    }
    // Fall back to draft for any slot Haiku didn't fill or returned empty.
    const headings = drafts.map((d, i) => {
      const h = typeof parsed[i] === 'string' ? parsed[i].trim() : ''
      return h.length > 3 ? h : d.draft
    })
    return { headings, ai_call_cost: 0.005 }
  } catch (err) {
    console.warn('[content-kit heading-polisher] Haiku failed, using drafts:', err instanceof Error ? err.message : String(err))
    return { headings: drafts.map(d => d.draft), ai_call_cost: 0 }
  }
}
