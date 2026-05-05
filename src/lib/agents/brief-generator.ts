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
import { reviewSingleBrief } from '@/lib/agents/tyr'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL              = 'claude-haiku-4-5-20251001'
const MAX_TOKENS          = 2048
const MAX_ATTEMPTS        = 3
const BASE_BACKOFF_MS     = 800   // 800ms, 1.6s, 3.2s

// ── Types ─────────────────────────────────────────────────────────────────────

interface PreviousTyrReview {
  score?:       number | null
  dimensions?:  Record<string, { score: number; comment: string }> | null
  strengths?:   string[]
  weaknesses?:  string[]
  suggestions?: { priority: 'high' | 'medium' | 'low'; text: string }[]
  reasoning?:   string
}

interface BriefInput {
  briefId:       string
  ownerId:       string
  keyword:       string
  pageUrl:       string
  briefType:     string
  searchVolume?: number
  competitorUrl?: string | null
  notes?:        string | null
  /**
   * Tyr's full review of the previous draft, when this generation is a
   * regenerate-after-failed-review. The prompt uses this to instruct the
   * LLM to fix specific weaknesses + heed prioritised suggestions, rather
   * than starting from a blank slate.
   */
  previousReview?: PreviousTyrReview | null
  /**
   * Internal flag set when this call is a self-triggered retry after Tyr
   * failed the brief on the first generation. Caps the auto-retry chain at
   * exactly ONE additional attempt — without this, a flaky Bragi run could
   * loop indefinitely. Manual user-triggered regenerates always set this
   * to false (each user click gets its own fresh chance).
   */
  isAutoRegenRetry?: boolean
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
  // Outreach briefs need a fundamentally different output (link-building pitch
  // template, NOT an SEO content brief). Delegate to the dedicated path.
  if (input.briefType === 'outreach') {
    return generateOutreachBrief(input)
  }

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

  // content_draft is the writer-facing summary header. Outline, FAQ, and
  // target keywords are NOT duplicated here — those are rendered separately
  // as structured sections by the brief detail page from
  // content_outline / faq_suggestions / new_keywords columns.
  // (Pre-2026-05 the draft had everything inline, which caused the FAQ
  // and outline to render twice on the brief page.)
  const draftLines: string[] = [
    `# ${parsed.suggestedH1}`,
    '',
    `**Meta description:** ${parsed.metaDescription}`,
    '',
    `**User intent:** ${parsed.userIntent}`,
  ]

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

  // ── Auto-run Tyr quality review immediately after Bragi generates ──────────
  // No need for manual trigger — Tyr scores the brief and writes tyr_score +
  // tyr_status back to the row. Errors are caught so a Tyr failure doesn't
  // surface as a Bragi failure.
  let tyrPassed = false
  let tyrBreakdown: Record<string, unknown> | null = null
  let tyrScore: number | null = null
  let tyrStatus: string | null = null
  try {
    const result = await reviewSingleBrief(input.briefId, input.ownerId)
    tyrPassed    = result.tyrStatus === 'reviewed'
    tyrBreakdown = result.breakdown as unknown as Record<string, unknown>
    tyrScore     = result.score
    tyrStatus    = result.tyrStatus
  } catch (tyrErr) {
    console.error('[brief-generator] Tyr auto-review failed (non-fatal):', tyrErr)
    // Brief stays at agent_generated — user can re-run Tyr manually from Brief Library
  }

  // ── If Tyr passes, kick off the full-article assembly step ─────────────────
  // Assembly is a SEPARATE Claude call (~30-45s on top of the ~40s already
  // spent on outline + Tyr). Awaiting it inline blows past Vercel Hobby's
  // 60s maxDuration cap on the parent lambda. So we trigger /assemble via a
  // fire-and-forget HTTP call — that endpoint owns its own 60s lambda budget.
  // If APP_URL or CRON_SECRET aren't configured (local dev), fall back to the
  // inline await so behaviour stays correct.
  if (tyrPassed) {
    const appUrl     = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ''
    const cronSecret = process.env.CRON_SECRET || ''
    if (appUrl && cronSecret) {
      // Decoupled path: fire-and-forget. /assemble has its own auth (Bearer).
      fetch(`${appUrl.replace(/\/$/, '')}/api/content/briefs/${input.briefId}/assemble`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${cronSecret}`,
        },
      }).catch(err => {
        console.error('[brief-generator] internal /assemble fetch failed:', err)
      })
    } else {
      // Local dev / missing env — run inline, accepting the slower wall-clock.
      try {
        await assembleFullArticle(input.briefId, input.ownerId)
      } catch (asmErr) {
        console.error('[brief-generator] inline assembly failed (non-fatal):', asmErr)
      }
    }
    return
  }

  // ── Auto-regenerate-once when Tyr fails ────────────────────────────────────
  // First-time Tyr fail (borderline OR failed) triggers one self-retry that
  // feeds Tyr's breakdown back as `previousReview`. This is bounded to exactly
  // ONE retry by `isAutoRegenRetry` — after that the brief stays at borderline/
  // failed for a human to decide. Prevents infinite loops on persistently
  // hard-to-pass briefs (e.g. niche with no SERP competitors).
  const shouldAutoRetry = !input.isAutoRegenRetry
                       && (tyrStatus === 'borderline' || tyrStatus === 'failed')
                       && tyrBreakdown !== null
  if (shouldAutoRetry) {
    console.warn(`[brief-generator] Tyr ${tyrStatus} (score ${tyrScore}/100) — auto-regenerating once with feedback`)
    try {
      await generateAgentBrief({
        ...input,
        notes: appendNote(input.notes ?? '', `[auto-regen 1] First Tyr attempt scored ${tyrScore}/100 (${tyrStatus}). Bragi retrying with breakdown feedback as context.`),
        previousReview: {
          score:       tyrScore,
          dimensions:  (tyrBreakdown as { dimensions?: Record<string, { score: number; comment: string }> }).dimensions ?? null,
          strengths:   (tyrBreakdown as { strengths?:  string[] }).strengths,
          weaknesses:  (tyrBreakdown as { weaknesses?: string[] }).weaknesses,
          suggestions: (tyrBreakdown as { suggestions?: { priority: 'high' | 'medium' | 'low'; text: string }[] }).suggestions,
          reasoning:   (tyrBreakdown as { reasoning?:  string }).reasoning,
        },
        isAutoRegenRetry: true,
      })
    } catch (retryErr) {
      console.error('[brief-generator] auto-regen retry failed:', retryErr)
    }
  }
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

  // Dedupe by normalised question text — Claude occasionally repeats the
  // same FAQ when given a long prompt or when re-running on borderline briefs.
  const faqsRaw = arr(raw.faqSuggestions).map(f => {
    const fq = f as Record<string, unknown>
    return {
      question:         str(fq.question),
      suggested_answer: str(fq.suggested_answer),
    }
  }).filter(f => f.question)
  const seenFaqs = new Set<string>()
  const faqs = faqsRaw.filter(f => {
    const key = f.question.trim().toLowerCase()
    if (seenFaqs.has(key)) return false
    seenFaqs.add(key)
    return true
  })

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

    // Platforms KB — injected for blog_post briefs to provide
    // writing rules for gaming editorial publications.
    // All platform entries are included (user manages what's relevant).
    // NOTE: KB UI persists with category='platform' (singular). Older code
    // here filtered for 'platforms' which silently dropped every entry —
    // confirmed bug, fixed 2026-05.
    const platformItems = kbItems.filter(i => i.category === 'platform')
    if (platformItems.length) {
      const platformBlocks = platformItems.map(i => {
        const d = i.data as Record<string, unknown>
        const lines = [
          `Platform: ${i.name}`,
          d.tone       ? `Tone: ${d.tone}`               : null,
          d.format     ? `Format: ${d.format}`           : null,
          d.guidelines ? `Guidelines: ${d.guidelines}`   : null,
          d.examples   ? `Examples: ${d.examples}`       : null,
          d.notes      ? `Notes: ${d.notes}`             : null,
        ].filter(Boolean)
        return lines.join('\n')
      }).join('\n\n')
      parts.push(`PLATFORM GUIDELINES (for external blog post):\n${platformBlocks}`)
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

  // ── Tyr regenerate-feedback block ──
  // When this is a regen of a brief that failed Tyr's review, inline Tyr's
  // structured feedback (per-dim weakness comments + prioritised suggestions)
  // so the LLM can specifically address what went wrong, instead of
  // generating from scratch with the same blind spots.
  const review = input.previousReview
  const regenBlock = review ? buildRegenFeedbackBlock(review) : ''

  const baseRequirements = `Quality requirements:

- suggestedH1: keyword-rich, specific to the page, NOT generic ("Buy X" is fine; "Welcome to G2G" is not).
- metaDescription: 150-160 chars, includes primary keyword and a clear CTA.
- userIntent: 1-2 sentences describing what the user actually wants (not what we want to sell).
- targetKeywords: primary keyword + 4-7 related long-tail variants and LSI terms (NOT just price/cheap/buy permutations — include intent-specific variants).
- contentOutline: 4-6 H2 sections, each with 2-4 bullet points. The first section should NOT be a generic "What is X" intro — start with what the user came here for (price comparison, listings, trust signals).
- faqSuggestions: 3-5 questions real users actually search (use "people also ask" style — pricing, safety, delivery time, refund policy).
- Anchor every section to commercial/transactional intent where the search clearly has buying intent. Avoid filler.`

  return `You are an expert SEO content strategist for G2G.com, a peer-to-peer gaming marketplace.

Create a structured SEO content brief for the following:

Target page: ${input.pageUrl}
Primary keyword: "${input.keyword}" (${volStr})
Brief type: ${input.briefType}
${input.competitorUrl ? `Reference competitor URL: ${input.competitorUrl}` : ''}
${input.notes ? `Context from upstream agent: ${input.notes}` : ''}
${kbBlock}

${isCategory ? 'This is a game category page that sells in-game currency, items, accounts, or boosting services. The content must serve buyers (help them find what they want and trust the marketplace) AND search intent.' : ''}

${regenBlock}

Call the submit_seo_brief tool with the structured brief. ${baseRequirements}`
}

/**
 * Build the "previous Tyr review" block injected into the regen prompt.
 *
 * Critically, this is structured — we don't just paste a JSON dump. We
 * surface the per-dimension scores < 7 (the failing ones) and the high/
 * medium priority suggestions. The LLM has been observed to treat
 * structured "what to fix" lists much more reliably than a freeform
 * "previous reasoning" paragraph.
 */
function buildRegenFeedbackBlock(review: PreviousTyrReview): string {
  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════════',
    '⚠ THIS IS A REGENERATION — the previous draft FAILED quality review',
    '═══════════════════════════════════════════════════════════════════',
  ]
  if (review.score != null) {
    lines.push(`Previous overall score: ${review.score}/100`)
  }
  if (review.reasoning) {
    lines.push(`Reviewer's overall verdict: ${review.reasoning}`)
  }

  // Per-dimension failures (score < 7 = clearly unfixed). Sort worst first.
  if (review.dimensions) {
    const failingDims = Object.entries(review.dimensions)
      .filter(([, v]) => v && typeof v.score === 'number' && v.score < 7)
      .sort(([, a], [, b]) => (a?.score ?? 0) - (b?.score ?? 0))

    if (failingDims.length > 0) {
      lines.push('')
      lines.push('DIMENSIONS THAT FAILED (must be fixed in this regen):')
      for (const [dim, v] of failingDims) {
        const label = dim.replace(/_/g, ' ')
        lines.push(`  • ${label} (${v.score}/10): ${v.comment ?? '—'}`)
      }
    }
  }

  if (review.weaknesses && review.weaknesses.length > 0) {
    lines.push('')
    lines.push('SPECIFIC WEAKNESSES IDENTIFIED (cite section/FAQ where relevant):')
    for (const w of review.weaknesses.slice(0, 5)) lines.push(`  • ${w}`)
  }

  if (review.suggestions && review.suggestions.length > 0) {
    lines.push('')
    lines.push('PRIORITISED SUGGESTIONS (apply HIGH and MEDIUM, consider LOW):')
    const sorted = [...review.suggestions].sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 } as const
      return (order[a.priority] ?? 3) - (order[b.priority] ?? 3)
    })
    for (const s of sorted.slice(0, 6)) {
      lines.push(`  • [${s.priority.toUpperCase()}] ${s.text}`)
    }
  }

  if (review.strengths && review.strengths.length > 0) {
    lines.push('')
    lines.push('PRESERVE these strengths from the previous draft:')
    for (const s of review.strengths.slice(0, 3)) lines.push(`  • ${s}`)
  }

  lines.push('')
  lines.push('When generating the new brief, treat the failing dimensions and HIGH/MEDIUM suggestions as MANDATORY fixes. Don\'t just rephrase — restructure the outline, FAQ, meta, and keyword strategy where the previous draft was weak.')
  lines.push('═══════════════════════════════════════════════════════════════════')

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Final-content assembly (Bragi step 2)
//
// After Tyr signs off on the brief, this function turns the outline + FAQs +
// target keywords into a publish-ready markdown article body and writes it to
// `seo_content_briefs.final_content`. The brief detail page surfaces this as
// the writer's working draft (with inline edit + translate).
//
// Errors are returned (not thrown) so callers (post-Tyr auto-trigger or manual
// /assemble endpoint) can decide what to do. The brief stays at 'reviewed'
// status whether or not assembly succeeds.
// ─────────────────────────────────────────────────────────────────────────────

const ASSEMBLY_MODEL       = 'claude-haiku-4-5-20251001'
const ASSEMBLY_MAX_TOKENS  = 4096
const ASSEMBLY_BACKOFF_MS  = 800

interface AssemblyOutlineSection { heading: string; points?: string[] }
interface AssemblyFaq            { question: string; suggested_answer?: string }
interface AssemblyKeyword        { keyword?: string; volume?: number | null }

type AssemblyResult =
  | { ok: true;  wordCount: number; model: string }
  | { ok: false; reason: string }

export async function assembleFullArticle(
  briefId: string,
  ownerId: string,
): Promise<AssemblyResult> {
  const db = createServiceClient()

  // ── Load brief + KB context ──
  const { data: brief, error: loadErr } = await db
    .from('seo_content_briefs')
    .select('*')
    .eq('id', briefId)
    .maybeSingle()

  if (loadErr || !brief) {
    return { ok: false, reason: `brief lookup failed: ${loadErr?.message ?? 'no row'}` }
  }

  const keyword     = String(brief.primary_keyword ?? '')
  const pageUrl     = String(brief.page ?? '')
  const briefType   = String(brief.brief_type ?? 'on_page')
  const h1Hint      = String(brief.content_draft ?? '').match(/^#\s+(.+)$/m)?.[1] ?? keyword
  const outline     = (Array.isArray(brief.content_outline) ? brief.content_outline : []) as AssemblyOutlineSection[]
  const faqs        = (Array.isArray(brief.faq_suggestions)  ? brief.faq_suggestions  : []) as AssemblyFaq[]
  const newKwsRaw   = (Array.isArray(brief.new_keywords)     ? brief.new_keywords     : []) as AssemblyKeyword[]
  const targetKws   = [keyword, ...newKwsRaw.map(k => k?.keyword).filter(Boolean) as string[]]
  const draftHeader = String(brief.content_draft ?? '')

  if (!outline.length) {
    return { ok: false, reason: 'brief has no content_outline (run Bragi step 1 first)' }
  }
  if (!keyword) {
    return { ok: false, reason: 'brief has no primary_keyword' }
  }

  // KB block (brand voice, category guidelines, platform rules)
  const kbBlock = await loadKBBlock(db, ownerId, pageUrl, keyword)

  // ── Build assembly prompt ──
  const outlineBlock = outline.map((s, i) => {
    const points = (s.points ?? []).map(p => `   - ${p}`).join('\n')
    return `${i + 1}. ## ${s.heading}\n${points}`
  }).join('\n\n')

  const faqBlock = faqs.length
    ? faqs.map(f => `- Q: ${f.question}\n  A (hint): ${f.suggested_answer ?? '(write a clear, concise answer)'}`).join('\n')
    : '(none — add a FAQ section anyway with 3 likely PAA-style questions)'

  const isCategoryPage = briefType === 'category_page' || pageUrl.includes('/categories/')

  const prompt = `You are the lead SEO writer for G2G (a leading gaming marketplace). The structured brief below has already been reviewed for quality. Now write the FULL article body in publish-ready markdown.

PAGE CONTEXT
- Primary keyword: "${keyword}"
- Page URL: ${pageUrl}
- Brief type: ${briefType}${isCategoryPage ? ' (category landing page)' : ''}
- Suggested H1: ${h1Hint}

TARGET KEYWORDS (1%–4% density on primary; ≤2% on secondaries; each must appear at least once):
${targetKws.slice(0, 8).map(k => `- ${k}`).join('\n')}

REQUIRED ARTICLE STRUCTURE
1. **H1** — the suggested title above (one line, # prefix)
2. **Lead paragraph** — 2-3 sentences (40-70 words) IMMEDIATELY after the H1, BEFORE any H2. This is non-negotiable. Establishes context: what the page is about, who it's for, why they should care. Include the primary keyword naturally in the FIRST sentence (helps Google's featured-snippet capture and gives readers a clean entry point). Mention 1-2 trust signals briefly. NO heading above this paragraph.
3. **Body sections** — one ## H2 per outline entry, in the order given below, ~150-300 words each.
4. **FAQ section** — at the end, "## Frequently Asked Questions" with the entries below.
5. **Closing paragraph** — soft CTA back to the page, no hard sell.

OUTLINE (each item below = one ## H2 section, written in order):
${outlineBlock}

FAQs to weave in (inside the closing FAQ section, NOT inline with body):
${faqBlock}

WRITING RULES
- Markdown headings: # for H1 (only one, at the very top), ## for section H2, ### for sub-points.
- Plain prose paragraphs. No HTML. No <br> tags. Use blank lines to separate paragraphs.
- DO NOT use the forbidden filler vocabulary: "immerse yourself", "step into", "dive into", "delve into", "embark", "captivating", "buckle up", "unravel", "thrill", "forge".
- Bold ONLY brand/feature names (e.g. **GamerProtect**) — never bold the primary keyword itself.
- Mention G2G's trust signals naturally: GamerProtect escrow, ISO/IEC 27001:2013 certified, 200+ payment methods, 24/7 support, transparent ratings. Do NOT mention competing marketplaces or the game's own publisher/developer.
- Hit the word count: minimum 800 words, target 1200-1500 for category pages, max 1800.
- Final paragraph should end with a soft CTA back to the page (no hard sell).
- Do NOT output meta description, target keyword list, or any "writing rules" headers — those live in the structured brief, not the article body.
- ⚠ NEVER skip the lead paragraph. The article MUST flow: H1 → lead paragraph (no heading) → first H2. If you go straight from H1 to H2, you have failed the brief.

${kbBlock}

OUTPUT FORMAT
Return ONLY the markdown article body. No preamble, no JSON, no explanation. Start with "# ${h1Hint}" on the first line.

${draftHeader ? `\nFor reference, the meta description and user intent already approved are:\n\n${draftHeader}\n` : ''}`

  // ── Call Claude (with one retry on transient errors) ──
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model:      ASSEMBLY_MODEL,
        max_tokens: ASSEMBLY_MAX_TOKENS,
        messages:   [{ role: 'user', content: prompt }],
      })

      logClaudeUsage(db, ownerId, {
        model:       ASSEMBLY_MODEL,
        endpoint:    'brief_assembly',
        triggeredBy: 'agent_bragi',
        usage:       response.usage,
        extra:       { brief_id: briefId, attempt },
      })

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n')
        .trim()

      if (!text || text.length < 200) {
        throw new Error(`assembly output too short (${text.length} chars)`)
      }

      // Strip code fences if Claude wrapped the markdown
      const cleaned = text.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()

      // ── Lead-paragraph validator ─────────────────────────────────────────
      // SEO requirement: H1 must be followed by a prose paragraph (40+ chars
      // of non-heading text) BEFORE the first H2. Without this, search engines
      // can't generate a featured snippet, and readers hit a wall of headings.
      // If the model skipped it, throw — caller retries with the rule already
      // emphasised in the prompt.
      const lines = cleaned.split(/\r?\n/)
      const h1Idx = lines.findIndex(l => /^#\s+/.test(l))
      const h2Idx = lines.findIndex((l, i) => i > h1Idx && /^##\s+/.test(l))
      if (h1Idx >= 0 && h2Idx > h1Idx) {
        const between = lines.slice(h1Idx + 1, h2Idx).join('\n').trim()
        // Strip blank lines and check we have actual prose, not just headings/lists/whitespace
        const proseLength = between
          .split(/\r?\n/)
          .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*') && !/^\d+\./.test(l.trim()))
          .join(' ')
          .trim().length
        if (proseLength < 40) {
          throw new Error(`missing lead paragraph between H1 and first H2 (only ${proseLength} chars of prose found)`)
        }
      }

      const wordCount = cleaned.split(/\s+/).filter(Boolean).length

      await db
        .from('seo_content_briefs')
        .update({
          final_content:               cleaned,
          final_content_generated_at:  new Date().toISOString(),
          updated_at:                  new Date().toISOString(),
          // Preserve any prior translations — don't blow away final_content_translations.
        })
        .eq('id', briefId)

      return { ok: true, wordCount, model: ASSEMBLY_MODEL }
    } catch (err) {
      lastErr = err
      console.warn(`[assembleFullArticle] attempt ${attempt}/2 failed:`, err instanceof Error ? err.message : err)
      if (attempt < 2) await sleep(ASSEMBLY_BACKOFF_MS)
    }
  }

  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
  return { ok: false, reason }
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTREACH brief generator
//
// Triggered when the user approves an opportunity with output_type='outreach'.
// Produces a MASTER PITCH TEMPLATE for link-building campaigns, NOT an SEO
// content brief. Hermod consumes this template later to personalise per-prospect
// emails (Hermod adds {{prospect_name}} / {{prospect_site}} fills).
//
// Field re-use in seo_content_briefs (one table, brief_type drives interpretation):
//   content_outline    → talking points (one section "Key Selling Points")
//   faq_suggestions    → objections + rebuttals (same shape, different label)
//   new_keywords       → anchor text variations (volume always null)
//   final_content      → email skeleton (subject + body + follow-up)
//   content_draft      → 1-line value proposition for header summary
// ─────────────────────────────────────────────────────────────────────────────

interface OutreachBrief {
  valueProposition:  string
  talkingPoints:     string[]
  anchorTextOptions: string[]
  emailSubjects:     string[]
  emailBody:         string
  followUpEmail:     string
  objections:        { question: string; suggested_answer: string }[]
}

const outreachTool: Anthropic.Tool = {
  name: 'submit_outreach_brief',
  description: 'Submit the structured link-building outreach pitch template.',
  input_schema: {
    type: 'object',
    properties: {
      valueProposition: {
        type: 'string',
        description: '1 paragraph (50-80 words). Why a gaming blogger / Discord mod / YouTuber should care about linking to G2G for this topic. Lead with value to THEIR audience, not what G2G wants.',
      },
      talkingPoints: {
        type: 'array',
        items: { type: 'string' },
        description: '5-7 concrete G2G facts that make the pitch credible. Examples: "ISO/IEC 27001:2013 certified", "GamerProtect escrow on every transaction", "200+ payment methods including local options", "24/7 support team". One fact per item, no fluff.',
      },
      anchorTextOptions: {
        type: 'array',
        items: { type: 'string' },
        description: '5-8 natural anchor text variations. Mix: 2-3 branded ("G2G", "G2G marketplace"), 2-3 generic ("verified marketplace", "trusted seller platform"), 2-3 topical (mention the keyword naturally). AVOID exact-match keyword stuffing — Google penalises that.',
      },
      emailSubjects: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 cold-email subject line variants. Under 50 chars. Conversational, NOT salesy. Personalize with {{prospect_site}} or {{topic}} placeholder where natural.',
      },
      emailBody: {
        type: 'string',
        description: 'Cold email body markdown. Use placeholders: {{prospect_name}}, {{prospect_site}}, {{topic}}. Structure: brief intro acknowledging their content (1-2 sentences) + value to their audience (1-2 sentences) + soft ask (resource share OR guest post offer) + closing. Max 150 words. Tone: friendly peer, not marketer.',
      },
      followUpEmail: {
        type: 'string',
        description: 'Follow-up email for non-responders after 5-7 days. ~80 words. Reference original lightly. Different angle — additional data point, alternative ask, or polite check-in. Same placeholders allowed.',
      },
      objections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question:         { type: 'string', description: 'Common objection or pushback.' },
            suggested_answer: { type: 'string', description: 'Honest, helpful response. Goal: keep conversation alive without overselling.' },
          },
          required: ['question', 'suggested_answer'],
        },
        description: '3-5 likely prospect objections with response scripts. Examples: "We don\'t do paid placements" → "Totally fine — this is a free resource, no payment expected.". "Not relevant to our audience" → polite reasoning + offer to send something more aligned.',
      },
    },
    required: ['valueProposition', 'talkingPoints', 'anchorTextOptions', 'emailSubjects', 'emailBody', 'followUpEmail', 'objections'],
  },
}

function buildOutreachPrompt(input: BriefInput, kbBlock: string): string {
  const review = input.previousReview
  const regenBlock = review ? buildRegenFeedbackBlock(review) : ''

  return `You are creating a LINK-BUILDING OUTREACH brief for G2G — a leading gaming marketplace selling in-game accounts, currencies, gift cards, top-ups (Robux, V-Bucks, etc.).

PAGE THAT NEEDS BACKLINKS
- Page URL: ${input.pageUrl}
- Topic: "${input.keyword}"
- Why we want links: ${input.notes ?? 'Drive referral traffic + improve domain authority for this commercial keyword.'}

YOUR TASK
Produce a MASTER PITCH TEMPLATE the outreach team will reuse across many prospects. Hermod (an automated outreach agent) personalises this per-prospect later by filling {{prospect_name}}, {{prospect_site}}, {{topic}} placeholders.

⚠ THIS IS NOT A CONTENT BRIEF.
Do NOT generate H1, meta description, content outline, sub-intent coverage, FAQ, heading structure, or article body.
DO generate ONLY the 7 fields the submit_outreach_brief tool requires.

PROSPECT TYPE (who we're pitching)
- Gaming bloggers covering ${input.keyword}'s game/genre
- Discord community moderators (relevant servers)
- YouTubers / streamers covering the niche
- Forum or wiki maintainers
- Resource curators (e.g. "Best [game] sites" listicles)

VOICE GUIDELINES
- Sound like a fellow gamer reaching out to peer, NOT a marketer.
- No exclamation marks. No "I hope this finds you well". No "I wanted to reach out".
- Open with something specific to THEIR content (placeholder for personalisation).
- Soft ask, never aggressive close. ALWAYS leave the door open if they decline.
- Honesty: don't oversell. If they say not interested, accept gracefully.

${kbBlock}

${regenBlock}

Use the submit_outreach_brief tool. Return all 7 fields. No preamble.`
}

function validateOutreachBrief(raw: Record<string, unknown>): OutreachBrief {
  const arr = (v: unknown) => Array.isArray(v) ? v : []
  const str = (v: unknown) => typeof v === 'string' ? v : ''

  const vp = str(raw.valueProposition).trim()
  if (vp.length < 30) throw new Error(`outreach valueProposition too short (${vp.length} chars)`)

  const talkingPoints = arr(raw.talkingPoints).map(p => str(p)).filter(Boolean).slice(0, 10)
  if (talkingPoints.length < 3) throw new Error(`outreach needs ≥3 talking points (got ${talkingPoints.length})`)

  const anchorTextOptions = arr(raw.anchorTextOptions).map(a => str(a).trim()).filter(Boolean).slice(0, 12)
  if (anchorTextOptions.length < 3) throw new Error(`outreach needs ≥3 anchor variations`)

  const emailSubjects = arr(raw.emailSubjects).map(s => str(s).trim()).filter(Boolean).slice(0, 6)
  if (emailSubjects.length < 2) throw new Error(`outreach needs ≥2 subject variants`)

  const emailBody     = str(raw.emailBody).trim()
  const followUpEmail = str(raw.followUpEmail).trim()
  if (emailBody.length     < 100) throw new Error(`outreach emailBody too short`)
  if (followUpEmail.length < 50)  throw new Error(`outreach followUpEmail too short`)

  const objections = arr(raw.objections).map(o => {
    const ob = o as Record<string, unknown>
    return { question: str(ob.question), suggested_answer: str(ob.suggested_answer) }
  }).filter(o => o.question && o.suggested_answer).slice(0, 6)

  return {
    valueProposition: vp,
    talkingPoints,
    anchorTextOptions,
    emailSubjects,
    emailBody,
    followUpEmail,
    objections,
  }
}

/**
 * Render the outreach brief into the writer-facing email skeleton stored in
 * final_content. This is what FinalContentPanel surfaces as the "ready to
 * paste into Gmail" markdown. Hermod also reads this when personalising.
 */
function renderOutreachEmailSkeleton(o: OutreachBrief): string {
  const subjects = o.emailSubjects.map((s, i) => `${i + 1}. ${s}`).join('\n')
  const anchors  = o.anchorTextOptions.map(a => `- ${a}`).join('\n')

  return [
    `# Outreach Pitch Templates`,
    ``,
    `**Value proposition:** ${o.valueProposition}`,
    ``,
    `## Subject Line Options`,
    ``,
    subjects,
    ``,
    `## Cold Email Body`,
    ``,
    `_Placeholders: {{prospect_name}}, {{prospect_site}}, {{topic}} — Hermod fills these per-prospect._`,
    ``,
    o.emailBody,
    ``,
    `## Follow-up (5-7 days after no reply)`,
    ``,
    o.followUpEmail,
    ``,
    `## Anchor Text Options`,
    ``,
    anchors,
    ``,
    `_Pick variety per prospect — never use the same anchor twice in a campaign. Branded > generic > topical, never exact-match._`,
  ].join('\n')
}

export async function generateOutreachBrief(input: BriefInput): Promise<void> {
  const db = createServiceClient()

  // Mark as generating
  await db
    .from('seo_content_briefs')
    .update({ status: 'generating' })
    .eq('id', input.briefId)

  let lastErr: unknown = null
  let parsed: OutreachBrief | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const kbBlock = await loadKBBlock(db, input.ownerId, input.pageUrl, input.keyword)
      const prompt  = buildOutreachPrompt(input, kbBlock)

      const response = await anthropic.messages.create({
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        tools:       [outreachTool],
        tool_choice: { type: 'tool', name: 'submit_outreach_brief' },
        messages:    [{ role: 'user', content: prompt }],
      })

      logClaudeUsage(db, input.ownerId, {
        model:       MODEL,
        endpoint:    'outreach_brief',
        triggeredBy: 'agent_bragi',
        usage:       response.usage,
        extra:       { brief_id: input.briefId, attempt },
      })

      const toolUse = response.content.find(b => b.type === 'tool_use')
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new Error(`Claude did not call submit_outreach_brief (stop_reason=${response.stop_reason})`)
      }

      parsed = validateOutreachBrief(toolUse.input as Record<string, unknown>)
      break
    } catch (err) {
      lastErr = err
      console.warn(`[outreach-generator] attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err instanceof Error ? err.message : err)
      if (attempt < MAX_ATTEMPTS) await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
    }
  }

  if (!parsed) {
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr)
    console.error('[outreach-generator] all retries failed:', reason)
    await db
      .from('seo_content_briefs')
      .update({
        status: 'draft',
        notes:  appendNote(input.notes ?? '', `[outreach-generator] auto-generation failed (${MAX_ATTEMPTS} attempts): ${reason}`),
      })
      .eq('id', input.briefId)
    return
  }

  // ── Persist using shared seo_content_briefs columns (semantic re-use) ─────
  const outlineJson = [{
    heading: 'Key Selling Points (Bragi-generated for outreach pitch)',
    points:  parsed.talkingPoints,
  }]
  const newKeywordsJson = parsed.anchorTextOptions.map(a => ({ keyword: a, volume: null }))
  const draftHeader     = `# Outreach Brief — ${input.keyword}\n\n**Value proposition:** ${parsed.valueProposition}\n\n_Hermod uses this brief to personalise per-prospect emails. The full email skeleton lives in Final Content below._`

  await db
    .from('seo_content_briefs')
    .update({
      status:           'agent_generated',
      content_outline:  outlineJson,
      content_draft:    draftHeader,
      faq_suggestions:  parsed.objections,                 // same shape: { question, suggested_answer }
      new_keywords:     newKeywordsJson,                   // anchor text re-uses keyword shape
      // Outreach skips the assembly step — the email skeleton IS the final
      // content. Stamp it directly so writers can review/edit immediately.
      final_content:               renderOutreachEmailSkeleton(parsed),
      final_content_generated_at:  new Date().toISOString(),
    })
    .eq('id', input.briefId)

  // ── Run Tyr review (same scoring engine — outreach gets relaxed thresholds
  // because the rubric is keyword-density-heavy and outreach pitch is short
  // form. Skipped for now: outreach Tyr scoring would need a separate rubric.
  // For Tema 2 ship, we stamp 'reviewed' immediately so the brief is usable. ──
  await db
    .from('seo_content_briefs')
    .update({
      status:          'reviewed',
      tyr_status:      'reviewed',
      tyr_score:       null,                               // intentionally null — different rubric
      tyr_reviewed_at: new Date().toISOString(),
      notes: appendNote(
        input.notes ?? '',
        '[outreach] Tyr scoring skipped — outreach uses a different rubric than SEO briefs. Brief auto-promoted to reviewed.',
      ),
    })
    .eq('id', input.briefId)
}
