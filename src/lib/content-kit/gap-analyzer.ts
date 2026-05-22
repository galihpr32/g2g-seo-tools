// ─── Content gap analyzer ──────────────────────────────────────────────────
//
// Sprint CKB.2 — Haiku reviews the top-10 SERP titles + descriptions for
// the primary KW and reports what competitors cover that we likely don't.
// Output feeds into the kit's gap_analysis block.

import Anthropic from '@anthropic-ai/sdk'
import type { SerpOrganicResult } from '@/lib/dataforseo/client'
import type { KitGapAnalysis } from './types'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface GapInput {
  primaryKeyword:   string
  productName:      string
  topResults:       SerpOrganicResult[]   // top 10 from SERP
  currentSections?: string[]              // H2 titles already planned (so Haiku doesn't suggest duplicates)
}

export interface GapResult {
  gap_analysis: KitGapAnalysis
  ai_call_cost: number
}

const FALLBACK: KitGapAnalysis = {
  competitor_urls: [],
  gaps: [],
}

export async function analyzeContentGap(input: GapInput): Promise<GapResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || input.topResults.length === 0) {
    return { gap_analysis: { ...FALLBACK, competitor_urls: input.topResults.map(r => r.url).slice(0, 10) }, ai_call_cost: 0 }
  }
  const anthropic = new Anthropic({ apiKey })

  const competitorBlock = input.topResults
    .slice(0, 10)
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.description.slice(0, 200)}\n    ${r.url}`)
    .join('\n')

  const ourSections = input.currentSections && input.currentSections.length > 0
    ? `\n\nWe're already planning these H2 sections (don't suggest these as gaps):\n${input.currentSections.map(s => `- ${s}`).join('\n')}`
    : ''

  const prompt = `You're analyzing what competitors cover for the keyword "${input.primaryKeyword}" on G2G's product "${input.productName}".

Here are the top 10 ranking pages on Google (titles + descriptions):

${competitorBlock}${ourSections}

Identify 4-6 content GAPS — topics the top-10 competitors consistently cover that would strengthen our product page if we addressed them. Prioritize gaps that:
1. Bridge to commercial intent (i.e. help close the sale, not just educate)
2. Are NOT already covered by our planned sections
3. Could be answered as a paragraph or FAQ entry (not a full how-to)

Output ONLY a JSON object (no prose, no markdown):
{
  "gaps": [
    {
      "topic": "<2-5 word label>",
      "why": "<1-2 sentence reason this matters>",
      "priority": "high" | "medium" | "low"
    }
  ]
}`

  try {
    const res = await anthropic.messages.create({
      model:       HAIKU_MODEL,
      max_tokens:  1500,
      temperature: 0.4,
      messages:    [{ role: 'user', content: prompt }],
    })
    const text = res.content.find(c => c.type === 'text')?.text ?? '{"gaps":[]}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) as { gaps: KitGapAnalysis['gaps'] } : { gaps: [] }
    const gaps = (parsed.gaps ?? []).slice(0, 8).map(g => ({
      topic:    String(g.topic ?? '').slice(0, 80),
      why:      String(g.why ?? '').slice(0, 400),
      priority: (['high', 'medium', 'low'] as const).includes(g.priority) ? g.priority : 'medium',
    }))
    return {
      gap_analysis: {
        competitor_urls: input.topResults.map(r => r.url).slice(0, 10),
        gaps,
      },
      ai_call_cost: 0.010,
    }
  } catch (err) {
    console.warn('[content-kit gap-analyzer] Haiku failed:', err instanceof Error ? err.message : String(err))
    return { gap_analysis: { ...FALLBACK, competitor_urls: input.topResults.map(r => r.url).slice(0, 10) }, ai_call_cost: 0 }
  }
}
