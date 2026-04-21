/**
 * brief-generator.ts
 *
 * Lightweight AI brief generation triggered when an Anak Intern `draft_brief`
 * action is approved. Uses Claude directly (no Firecrawl / DataForSEO) to
 * produce a usable content outline + on-page brief stub.
 *
 * Updates the `seo_content_briefs` row from status 'draft' → 'agent_generated'.
 * The writer can then open it in Content Studio and refine / run the full pipeline.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Types ─────────────────────────────────────────────────────────────────────

interface BriefInput {
  briefId:       string
  ownerId:       string
  keyword:       string
  pageUrl:       string
  briefType:     string
  searchVolume?: number
  competitorUrl?: string | null
  notes?:        string | null
}

interface ParsedBrief {
  suggestedH1:     string
  metaDescription: string
  userIntent:      string
  contentOutline:  OutlineSection[]
  targetKeywords:  string[]
  faqSuggestions:  { question: string; suggested_answer: string }[]
}

interface OutlineSection {
  heading: string
  points:  string[]
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Async — call without await so executor returns fast.
 * Generates a brief in the background and updates the DB record.
 */
export async function generateAgentBrief(input: BriefInput): Promise<void> {
  const db = createServiceClient()

  // Mark as generating
  await db
    .from('seo_content_briefs')
    .update({ status: 'generating' })
    .eq('id', input.briefId)

  try {
    // Load brand + category KB context for this owner
    const kbBlock = await loadKBBlock(db, input.ownerId, input.pageUrl)

    const prompt = buildPrompt(input, kbBlock)

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',   // fast + cheap for structured output
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    const rawText = response.content[0].type === 'text' ? response.content[0].text : ''
    const parsed  = parseBriefResponse(rawText, input.keyword)

    // Build content_outline JSON (matches existing schema)
    const outlineJson = parsed.contentOutline.map(s => ({
      heading: s.heading,
      points:  s.points,
    }))

    // Build a readable content_draft summary for the brief viewer
    const draftLines: string[] = [
      `# ${parsed.suggestedH1}`,
      '',
      `**Meta description:** ${parsed.metaDescription}`,
      '',
      `**User intent:** ${parsed.userIntent}`,
      '',
      `**Target keywords:** ${parsed.targetKeywords.join(', ')}`,
      '',
      '---',
      '',
      '## Content Outline',
      '',
      ...parsed.contentOutline.flatMap(s => [
        `### ${s.heading}`,
        ...s.points.map(p => `- ${p}`),
        '',
      ]),
    ]

    if (parsed.faqSuggestions.length) {
      draftLines.push('## FAQ Suggestions', '')
      for (const faq of parsed.faqSuggestions) {
        draftLines.push(`**Q: ${faq.question}**`)
        if (faq.suggested_answer) draftLines.push(`A: ${faq.suggested_answer}`)
        draftLines.push('')
      }
    }

    await db
      .from('seo_content_briefs')
      .update({
        status:              'agent_generated',
        content_outline:     outlineJson,
        content_draft:       draftLines.join('\n'),
        faq_suggestions:     parsed.faqSuggestions,
        new_keywords:        parsed.targetKeywords.slice(1).map(k => ({ keyword: k, volume: null })),
      })
      .eq('id', input.briefId)

  } catch (err) {
    console.error('[brief-generator] generation failed:', err)
    // Revert to draft so the writer can still open it manually
    await db
      .from('seo_content_briefs')
      .update({ status: 'draft' })
      .eq('id', input.briefId)
  }
}

// ── KB loader ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadKBBlock(db: any, ownerId: string, pageUrl: string): Promise<string> {
  try {
    const { data: kbItems } = await db
      .from('knowledge_base_items')
      .select('category, name, data')
      .eq('owner_user_id', ownerId)

    if (!kbItems?.length) return ''

    const urlSlug = (() => {
      try { return new URL(pageUrl).pathname.split('/').filter(Boolean).join(' ').toLowerCase() }
      catch { return pageUrl.toLowerCase() }
    })()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brand = (kbItems as any[]).find((i: any) => i.category === 'brand')
    const brandData = (brand?.data ?? {}) as Record<string, unknown>

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchedCategory = (kbItems as any[])
      .filter((i: any) => i.category === 'category')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((i: any) =>
        urlSlug.includes((i.name as string).toLowerCase()) ||
        (i.name as string).toLowerCase().split(/\s+/).some((w: string) => urlSlug.includes(w))
      )
    const catData = (matchedCategory?.data ?? {}) as Record<string, unknown>

    const parts: string[] = []

    if (brandData.tone || brandData.audience) {
      parts.push([
        'BRAND CONTEXT:',
        brandData.tone     ? `Tone: ${brandData.tone}`         : '',
        brandData.audience ? `Audience: ${brandData.audience}` : '',
      ].filter(Boolean).join('\n'))
    }

    if (catData.description || catData.angle) {
      parts.push([
        'CATEGORY CONTEXT:',
        catData.description ? `Description: ${catData.description}` : '',
        catData.angle       ? `Content angle: ${catData.angle}`      : '',
      ].filter(Boolean).join('\n'))
    }

    return parts.length ? `\n---\n${parts.join('\n\n')}\n---\n` : ''
  } catch {
    return ''
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(input: BriefInput, kbBlock: string): string {
  const volStr = input.searchVolume ? `${input.searchVolume.toLocaleString()} monthly searches` : 'unknown volume'
  const isCategory = input.briefType === 'category_page' || input.pageUrl.includes('/categories/')

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace.

Create a structured SEO content brief for the following:

Target page: ${input.pageUrl}
Primary keyword: "${input.keyword}" (${volStr})
Brief type: ${input.briefType}
${input.competitorUrl ? `Reference competitor: ${input.competitorUrl}` : ''}
${input.notes ? `Context: ${input.notes}` : ''}
${kbBlock}

${isCategory ? 'This is a game category page that sells in-game currency, items, and accounts. The content should help buyers find what they want and build trust.' : ''}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "suggestedH1": "...",
  "metaDescription": "...",
  "userIntent": "...",
  "targetKeywords": ["primary", "secondary", ...up to 8 keywords],
  "contentOutline": [
    {
      "heading": "H2 heading",
      "points": ["key point 1", "key point 2", "key point 3"]
    }
  ],
  "faqSuggestions": [
    {
      "question": "...",
      "suggested_answer": "..."
    }
  ]
}

Requirements:
- suggestedH1: compelling, keyword-rich, specific to the page
- metaDescription: 150-160 chars, includes primary keyword, has a call to action
- userIntent: 1-2 sentences describing what the user wants when searching this keyword
- contentOutline: 4-6 H2 sections, each with 2-4 bullet points covering what to write
- targetKeywords: primary + related long-tail variants, LSI terms
- faqSuggestions: 3-5 questions real users would search, with brief answers
- Focus on commercial/transactional intent where relevant for a marketplace context`
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseBriefResponse(raw: string, keyword: string): ParsedBrief {
  // Try to extract JSON from the response
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return fallbackBrief(keyword)

  try {
    const data = JSON.parse(jsonMatch[0])

    return {
      suggestedH1:     String(data.suggestedH1 || `${keyword} — Buy & Sell on G2G`),
      metaDescription: String(data.metaDescription || ''),
      userIntent:      String(data.userIntent || ''),
      contentOutline:  Array.isArray(data.contentOutline)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? data.contentOutline.map((s: any) => ({
            heading: String(s.heading || ''),
            points:  Array.isArray(s.points) ? s.points.map(String) : [],
          }))
        : [],
      targetKeywords:  Array.isArray(data.targetKeywords)
        ? data.targetKeywords.map(String).slice(0, 8)
        : [keyword],
      faqSuggestions:  Array.isArray(data.faqSuggestions)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? data.faqSuggestions.map((f: any) => ({
            question:         String(f.question || ''),
            suggested_answer: String(f.suggested_answer || ''),
          }))
        : [],
    }
  } catch {
    return fallbackBrief(keyword)
  }
}

function fallbackBrief(keyword: string): ParsedBrief {
  return {
    suggestedH1:     `Buy ${keyword} — G2G Marketplace`,
    metaDescription: `Find the best ${keyword} deals on G2G. Safe, fast, and reliable marketplace for gamers worldwide.`,
    userIntent:      `Users want to buy or sell ${keyword} quickly and safely.`,
    contentOutline:  [
      { heading: `What is ${keyword}?`, points: ['Explain the game/item', 'Who it\'s for', 'Why it\'s popular'] },
      { heading: 'Why Buy on G2G?', points: ['Safe transactions', 'Competitive prices', 'Fast delivery'] },
      { heading: 'How to Buy', points: ['Search sellers', 'Compare offers', 'Complete purchase safely'] },
    ],
    targetKeywords:  [keyword, `buy ${keyword}`, `${keyword} for sale`, `cheap ${keyword}`],
    faqSuggestions:  [
      { question: `How do I buy ${keyword} safely?`, suggested_answer: 'Use G2G\'s secure platform with buyer protection.' },
      { question: `What is the best price for ${keyword}?`, suggested_answer: 'Compare multiple sellers on G2G to find the best deal.' },
    ],
  }
}
