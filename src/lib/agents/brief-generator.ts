/**
 * brief-generator.ts
 *
 * Generates a usable SEO content outline + on-page brief stub for an
 * approved Bragi `draft_brief` action. Uses Claude's tool_use for
 * structured JSON output (no more regex JSON extraction). Retries with
 * exponential backoff on transient failures.
 *
 * Updates the `seo_content_briefs` row from status 'draft' → 'agent_generated'.
 * If all retries fail, status reverts to 'draft' so the writer can still
 * open it manually, and the failure reason is logged into `notes`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { slugify } from '@/lib/agents/site-helpers'
import { logClaudeUsage } from '@/lib/api-logger'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL              = 'claude-haiku-4-5-20251001'
const MAX_TOKENS          = 2048
const MAX_ATTEMPTS        = 3
const BASE_BACKOFF_MS     = 800   // 800ms, 1.6s, 3.2s

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

interface OutlineSection { heading: string; points: string[] }

interface ParsedBrief {
  suggestedH1:     string
  metaDescription: string
  userIntent:      string
  contentOutline:  OutlineSection[]
  targetKeywords:  string[]
  faqSuggestions:  { question: string; suggested_answer: string }[]
}

// ── Tool schema for structured output ─────────────────────────────────────────

const briefTool: Anthropic.Tool = {
  name: 'submit_seo_brief',
  description: 'Submit the structured SEO content brief.',
  input_schema: {
    type: 'object',
    properties: {
      suggestedH1:     { type: 'string', description: 'Compelling, keyword-rich H1 specific to the page.' },
      metaDescription: { type: 'string', description: 'Meta description, 150-160 chars, includes primary keyword and a CTA.' },
      userIntent:      { type: 'string', description: '1-2 sentences: what the user wants when searching this keyword.' },
      targetKeywords:  {
        type: 'array',
        items: { type: 'string' },
        description: 'Primary + 4-7 related long-tail variants and LSI terms.',
      },
      contentOutline:  {
        type: 'array',
        description: '4-6 H2 sections, each with 2-4 bullet points covering what to write.',
        items: {
          type: 'object',
          properties: {
            heading: { type: 'string' },
            points:  { type: 'array', items: { type: 'string' } },
          },
          required: ['heading', 'points'],
        },
      },
      faqSuggestions:  {
        type: 'array',
        description: '3-5 questions real users would search, each with a brief answer.',
        items: {
          type: 'object',
          properties: {
            question:         { type: 'string' },
            suggested_answer: { type: 'string' },
          },
          required: ['question', 'suggested_answer'],
        },
      },
    },
    required: ['suggestedH1', 'metaDescription', 'userIntent', 'targetKeywords', 'contentOutline', 'faqSuggestions'],
  },
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateAgentBrief(input: BriefInput): Promise<void> {
  const db = createServiceClient()

  // Mark as generating
  await db
    .from('seo_content_briefs')
    .update({ status: 'generating' })
    .eq('id', input.briefId)

  let lastErr: unknown = null
  let parsed: ParsedBrief | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const kbBlock = await loadKBBlock(db, input.ownerId, input.pageUrl, input.keyword)
      const prompt  = buildPrompt(input, kbBlock)

      const response = await anthropic.messages.create({
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        tools:       [briefTool],
        tool_choice: { type: 'tool', name: 'submit_seo_brief' },
        messages:    [{ role: 'user', content: prompt }],
      })

      logClaudeUsage(db, input.ownerId, {
        model:       MODEL,
        endpoint:    'brief_outline',
        triggeredBy: 'agent_bragi',
        usage:       response.usage,
        extra:       { brief_id: input.briefId, attempt },
      })

      // Find the tool_use block
      const toolUse = response.content.find(b => b.type === 'tool_use')
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`Claude did not call submit_seo_brief tool (stop_reason=${response.stop_reason})`)
      }

      parsed = validateAndCoerce(toolUse.input as Record<string, unknown>, input.keyword)
      break  // success
    } catch (err) {
      lastErr = err
      const isLast = attempt === MAX_ATTEMPTS
      console.warn(`[brief-generator] attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err instanceof Error ? err.message : err)
      if (!isLast) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
      }
    }
  }

  if (!parsed) {
    // All retries failed — revert to 'draft' and log the reason
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
    console.error('[brief-generator] all retries failed:', reason)
    await db
      .from('seo_content_briefs')
      .update({
        status: 'draft',
        notes: appendNote(input.notes ?? '', `[brief-generator] auto-generation failed (${MAX_ATTEMPTS} attempts): ${reason}`),
      })
      .eq('id', input.briefId)
    return
  }

  // Persist successfully-parsed brief
  const outlineJson = parsed.contentOutline.map(s => ({ heading: s.heading, points: s.points }))

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
      status:           'agent_generated',
      content_outline:  outlineJson,
      content_draft:    draftLines.join('\n'),
      faq_suggestions:  parsed.faqSuggestions,
      new_keywords:     parsed.targetKeywords.slice(1).map(k => ({ keyword: k, volume: null })),
    })
    .eq('id', input.briefId)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function appendNote(existing: string, line: string): string {
  return existing ? `${existing}\n\n${line}` : line
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function validateAndCoerce(raw: Record<string, unknown>, keyword: string): ParsedBrief {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  const str = (v: unknown) => typeof v === 'string' ? v : ''

  const outline = arr(raw.contentOutline).map(s => {
    const sec = s as Record<string, unknown>
    return {
      heading: str(sec.heading),
      points:  arr(sec.points).map(p => String(p)),
    }
  }).filter(s => s.heading)

  const faqs = arr(raw.faqSuggestions).map(f => {
    const fq = f as Record<string, unknown>
    return {
      question:         str(fq.question),
      suggested_answer: str(fq.suggested_answer),
    }
  }).filter(f => f.question)

  const targetKws = arr(raw.targetKeywords).map(k => String(k)).slice(0, 8)
  if (!targetKws.includes(keyword)) targetKws.unshift(keyword)

  // Reject obviously-empty briefs by throwing — caller will retry
  if (!outline.length || outline.length < 2) {
    throw new Error(`Brief outline too short (${outline.length} sections); retrying`)
  }

  return {
    suggestedH1:     str(raw.suggestedH1) || `${keyword} — Buy & Sell on G2G`,
    metaDescription: str(raw.metaDescription),
    userIntent:      str(raw.userIntent),
    contentOutline:  outline,
    targetKeywords:  targetKws.slice(0, 8),
    faqSuggestions:  faqs,
  }
}

// ── KB loader ─────────────────────────────────────────────────────────────────

interface KBItem {
  category: string
  name:     string
  data:     Record<string, unknown>
}

async function loadKBBlock(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  ownerId: string,
  pageUrl: string,
  keyword: string,
): Promise<string> {
  try {
    const { data: kbItemsRaw } = await db
      .from('knowledge_base_items')
      .select('category, name, data')
      .eq('owner_user_id', ownerId)

    const kbItems: KBItem[] = (kbItemsRaw ?? []) as KBItem[]
    if (!kbItems.length) return ''

    const urlSlug = slugifyPath(pageUrl)
    const kwSlug  = slugify(keyword)

    const brand = kbItems.find(i => i.category === 'brand')
    const brandData = (brand?.data ?? {}) as Record<string, unknown>

    // Score each category KB by token overlap with URL slug + keyword slug.
    // Pick the best match (>=1 token shared). This handles "WoW Items" KB
    // matching `/categories/buy-wow-gold` via the 'wow' token.
    const categoryItems = kbItems.filter(i => i.category === 'category')
    const scored = categoryItems.map(i => {
      const nameTokens = slugify(i.name).split('-').filter(t => t.length >= 3)
      const urlTokens  = urlSlug.split('-').filter(t => t.length >= 3)
      const kwTokens   = kwSlug.split('-').filter(t => t.length >= 3)
      const targetSet  = new Set([...urlTokens, ...kwTokens])
      const overlap    = nameTokens.filter(t => targetSet.has(t)).length
      return { item: i, overlap }
    })
    scored.sort((a, b) => b.overlap - a.overlap)
    const matchedCategory = scored.length && scored[0].overlap >= 1 ? scored[0].item : null

    const catData = (matchedCategory?.data ?? {}) as Record<string, unknown>
    const parts: string[] = []

    if (brandData.tone || brandData.audience) {
      parts.push([
        'BRAND CONTEXT:',
        brandData.tone     ? `Tone: ${brandData.tone}`         : '',
        brandData.audience ? `Audience: ${brandData.audience}` : '',
      ].filter(Boolean).join('\n'))
    }

    if (matchedCategory && (catData.description || catData.angle)) {
      parts.push([
        `CATEGORY CONTEXT — ${matchedCategory.name}:`,
        catData.description ? `Description: ${catData.description}` : '',
        catData.angle       ? `Content angle: ${catData.angle}`      : '',
      ].filter(Boolean).join('\n'))
    }

    return parts.length ? `\n---\n${parts.join('\n\n')}\n---\n` : ''
  } catch (e) {
    console.warn('[brief-generator] KB load failed:', e)
    return ''
  }
}

function slugifyPath(pageUrl: string): string {
  try {
    const u = new URL(pageUrl)
    return slugify(u.pathname.split('/').filter(Boolean).join(' '))
  } catch {
    return slugify(pageUrl)
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(input: BriefInput, kbBlock: string): string {
  const volStr     = input.searchVolume ? `${input.searchVolume.toLocaleString()} monthly searches` : 'unknown volume'
  const isCategory = input.briefType === 'category_page' || input.pageUrl.includes('/categories/')

  return `You are an expert SEO content strategist for G2G.com, a peer-to-peer gaming marketplace.

Create a structured SEO content brief for the following:

Target page: ${input.pageUrl}
Primary keyword: "${input.keyword}" (${volStr})
Brief type: ${input.briefType}
${input.competitorUrl ? `Reference competitor URL: ${input.competitorUrl}` : ''}
${input.notes ? `Context from upstream agent: ${input.notes}` : ''}
${kbBlock}

${isCategory ? 'This is a game category page that sells in-game currency, items, accounts, or boosting services. The content must serve buyers (help them find what they want and trust the marketplace) AND search intent.' : ''}

Call the submit_seo_brief tool with the structured brief. Quality requirements:

- suggestedH1: keyword-rich, specific to the page, NOT generic ("Buy X" is fine; "Welcome to G2G" is not).
- metaDescription: 150-160 chars, includes primary keyword and a clear CTA.
- userIntent: 1-2 sentences describing what the user actually wants (not what we want to sell).
- targetKeywords: primary keyword + 4-7 related long-tail variants and LSI terms (NOT just price/cheap/buy permutations — include intent-specific variants).
- contentOutline: 4-6 H2 sections, each with 2-4 bullet points. The first section should NOT be a generic "What is X" intro — start with what the user came here for (price comparison, listings, trust signals).
- faqSuggestions: 3-5 questions real users actually search (use "people also ask" style — pricing, safety, delivery time, refund policy).
- Anchor every section to commercial/transactional intent where the search clearly has buying intent. Avoid filler.`
}
