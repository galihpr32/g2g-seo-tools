import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { smartScrape } from '@/lib/firecrawl/client'
import { batchSerpData, getKeywordSuggestions } from '@/lib/dataforseo/client'
import { buildCategoryInstructions, detectCategory } from '@/lib/g2g-category-prompts'
import { detectPageLanguage, type PageLanguage } from '@/lib/language-detect'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 120 // briefs take time — requires Vercel Pro

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── POST /api/brief/generate ─────────────────────────────────────────────────
// Body: { action_item_id: string }
// Generates an on-page or off-page brief for the given action item,
// using Firecrawl (page crawl) + DataForSEO (SERP/PAA/keywords) + Claude (analysis + draft)

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', effectiveOwnerId)
    .single()
  if (!conn?.site_url) return NextResponse.json({ error: 'No GSC connection' }, { status: 400 })

  const reqBody = await request.json()
  const { action_item_id, content_type_config, selected_keywords, custom_instructions } = reqBody as {
    action_item_id: string
    content_type_config?: Record<string, { enabled: boolean; count: number; format?: 'short' | 'long' }>
    selected_keywords?: string[]   // user-curated keywords from pre-generate step
    custom_instructions?: string   // editor-supplied freeform instructions
  }
  if (!action_item_id) return NextResponse.json({ error: 'Missing action_item_id' }, { status: 400 })

  // Load the action item
  const { data: item } = await supabase
    .from('seo_action_items')
    .select('*')
    .eq('id', action_item_id)
    .single()
  if (!item) return NextResponse.json({ error: 'Action item not found' }, { status: 404 })

  // Load GSC queries for this page (already stored from ranking drop)
  const { data: gscQueries } = await supabase
    .from('gsc_ranking_drop_queries')
    .select('query, clicks, impressions, ctr, position')
    .eq('site_url', conn.site_url)
    .eq('page', item.page)
    .order('clicks', { ascending: false })
    .limit(10)

  const topQueries = (gscQueries ?? []).map(q => q.query)
  const primaryKeyword = topQueries[0] ?? deriveTopicFromUrl(item.page)

  // ── Create initial DB record (status: generating) ─────────────────────────
  const { data: brief, error: insertErr } = await supabase
    .from('seo_content_briefs')
    .insert({
      site_url: conn.site_url,
      action_item_id,
      page: item.page,
      brief_type: item.action_type,
      status: 'generating',
      primary_keyword: primaryKeyword,
    })
    .select()
    .single()

  if (insertErr || !brief) {
    return NextResponse.json({ error: insertErr?.message ?? 'Insert failed' }, { status: 500 })
  }

  // ── Schedule pipeline to run AFTER response is sent ──────────────────────
  // `after()` keeps the serverless function alive until the promise resolves,
  // even after the HTTP response is returned to the client.
  after(
    runBriefPipeline(brief.id, item, topQueries, primaryKeyword, conn.site_url, gscQueries ?? [], content_type_config, selected_keywords, custom_instructions)
      .catch(err => console.error('Brief pipeline error:', err))
  )

  return NextResponse.json({ brief_id: brief.id, status: 'generating' })
}

// ── GET /api/brief/generate?id=... — poll for status ─────────────────────────
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

  const { data: brief } = await supabase
    .from('seo_content_briefs')
    .select('*')
    .eq('id', id)
    .single()

  if (!brief) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(brief)
}

type ContentTypeConfig = Record<string, { enabled: boolean; count: number; format?: 'short' | 'long' }>

// ─── Knowledge Base context types ─────────────────────────────────────────────
interface KBContext {
  brandTone: string
  brandAudience: string
  brandDos: string[]
  brandDonts: string[]
  brandNotes: string
  categoryDescription: string
  categoryBuyerIntent: string
  categoryKeywords: string[]
  categoryAngle: string
  categoryNotes: string
  dmcaTerms: Array<{ original: string; replacement: string }>
}

// ─── Load knowledge base context ──────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadKBContext(
  supabase: any,
  ownerId: string,
  pageUrl: string
): Promise<KBContext> {
  const empty: KBContext = {
    brandTone: '', brandAudience: '', brandDos: [], brandDonts: [], brandNotes: '',
    categoryDescription: '', categoryBuyerIntent: '', categoryKeywords: [], categoryAngle: '', categoryNotes: '',
    dmcaTerms: [],
  }

  try {
    // Load all KB items for this owner
    const { data: kbItems } = await supabase
      .from('knowledge_base_items')
      .select('category, name, data')
      .eq('owner_user_id', ownerId)

    // Load active DMCA terms
    const { data: dmcaTerms } = await supabase
      .from('dmca_terms')
      .select('original_term, replacement_term')
      .eq('owner_user_id', ownerId)
      .eq('active', true)

    if (!kbItems) return empty

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const brand = (kbItems as any[]).find((i: any) => i.category === 'brand')
    const brandData = (brand?.data ?? {}) as Record<string, unknown>

    // Try to find a matching category from the URL slug
    const urlSlug = (() => {
      try { return new URL(pageUrl).pathname.split('/').filter(Boolean).join(' ').toLowerCase() }
      catch { return pageUrl.toLowerCase() }
    })()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const categoryItems = (kbItems as any[]).filter((i: any) => i.category === 'category')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchedCategory = categoryItems.find((i: any) =>
      urlSlug.includes(i.name.toLowerCase()) ||
      i.name.toLowerCase().split(/\s+/).some((word: string) => urlSlug.includes(word))
    )
    const catData = (matchedCategory?.data ?? {}) as Record<string, unknown>

    return {
      brandTone:            (brandData.tone         as string) ?? '',
      brandAudience:        (brandData.audience     as string) ?? '',
      brandDos:             (brandData.dos          as string[]) ?? [],
      brandDonts:           (brandData.donts        as string[]) ?? [],
      brandNotes:           (brandData.notes        as string) ?? '',
      categoryDescription:  (catData.description   as string) ?? '',
      categoryBuyerIntent:  (catData.buyer_intent  as string) ?? '',
      categoryKeywords:     (catData.keywords      as string[]) ?? [],
      categoryAngle:        (catData.angle         as string) ?? '',
      categoryNotes:        (catData.notes         as string) ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dmcaTerms: ((dmcaTerms ?? []) as any[]).map((t: any) => ({ original: t.original_term, replacement: t.replacement_term })),
    }
  } catch {
    return empty
  }
}

// ─── Build KB context injection block ─────────────────────────────────────────
function buildKBBlock(kb: KBContext, includeDmca = true): string {
  const parts: string[] = []

  if (kb.brandTone || kb.brandAudience || kb.brandDos.length || kb.brandDonts.length) {
    parts.push(`BRAND CONTEXT (MUST FOLLOW):
Tone: ${kb.brandTone || 'Not specified'}
Audience: ${kb.brandAudience || 'Not specified'}
${kb.brandDos.filter(Boolean).length ? `DOs:\n${kb.brandDos.filter(Boolean).map(d => `- ${d}`).join('\n')}` : ''}
${kb.brandDonts.filter(Boolean).length ? `DON'Ts:\n${kb.brandDonts.filter(Boolean).map(d => `- ${d}`).join('\n')}` : ''}
${kb.brandNotes ? `Notes: ${kb.brandNotes}` : ''}`.trim())
  }

  if (kb.categoryDescription || kb.categoryAngle || kb.categoryKeywords.length) {
    parts.push(`CATEGORY CONTEXT:
${kb.categoryDescription ? `Description: ${kb.categoryDescription}` : ''}
${kb.categoryBuyerIntent ? `Buyer intent: ${kb.categoryBuyerIntent}` : ''}
${kb.categoryAngle ? `Content angle: ${kb.categoryAngle}` : ''}
${kb.categoryKeywords.filter(Boolean).length ? `Category keywords: ${kb.categoryKeywords.filter(Boolean).join(', ')}` : ''}
${kb.categoryNotes ? `Notes: ${kb.categoryNotes}` : ''}`.trim())
  }

  if (includeDmca && kb.dmcaTerms.length) {
    parts.push(`RESTRICTED TERMS (apply replacements in all content):
${kb.dmcaTerms.map(t => `- Replace "${t.original}" with "${t.replacement}"`).join('\n')}`)
  }

  return parts.length ? `\n---\n${parts.join('\n\n')}\n---\n` : ''
}

// ─── Apply DMCA replacements to generated text ────────────────────────────────
function applyDmcaReplacements(text: string, terms: Array<{ original: string; replacement: string }>): string {
  let result = text
  for (const term of terms) {
    if (!term.original) continue
    // Case-insensitive whole-word replacement, preserving case shape
    const re = new RegExp(`\\b${term.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    result = result.replace(re, (match) => {
      if (match === match.toUpperCase()) return term.replacement.toUpperCase()
      if (match[0] === match[0].toUpperCase()) return term.replacement.charAt(0).toUpperCase() + term.replacement.slice(1)
      return term.replacement
    })
  }
  return result
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────
async function runBriefPipeline(
  briefId: string,
  item: any,
  topQueries: string[],
  primaryKeyword: string,
  siteUrl: string,
  gscQueries: any[],
  contentTypeConfig?: ContentTypeConfig,
  selectedKeywords?: string[],
  customInstructions?: string
) {
  // Use service role client so writes always succeed regardless of auth context
  const { createClient: createServiceClient } = await import('@supabase/supabase-js')
  const supabase = createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  async function updateBrief(fields: Record<string, unknown>) {
    const { error } = await supabase.from('seo_content_briefs').update(fields).eq('id', briefId)
    if (error) console.error('updateBrief error:', error.message)
  }

  try {
    // Load the brief to get owner_user_id
    const { data: briefRow } = await supabase
      .from('seo_content_briefs')
      .select('owner_user_id')
      .eq('id', briefId)
      .single()
    const ownerId: string = briefRow?.owner_user_id ?? ''

    // Load KB context once for the pipeline
    const kb = ownerId
      ? await loadKBContext(supabase as any, ownerId, item.page)
      : { brandTone: '', brandAudience: '', brandDos: [], brandDonts: [], brandNotes: '',
          categoryDescription: '', categoryBuyerIntent: '', categoryKeywords: [], categoryAngle: '', categoryNotes: '',
          dmcaTerms: [] }

    // Detect language from the target page URL
    const lang = detectPageLanguage(item.page)

    if (item.action_type === 'on_page') {
      await runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, selectedKeywords, customInstructions })
    } else {
      await runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, contentTypeConfig, kb, lang, customInstructions })
    }
  } catch (err) {
    console.error('Pipeline failed:', err)
    await updateBrief({ status: 'draft', content_draft: `Pipeline error: ${err}` })
  }
}

// ─── ON-PAGE Pipeline ──────────────────────────────────────────────────────────
async function runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, selectedKeywords, customInstructions }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  kb: KBContext
  lang: PageLanguage
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  // Step 1: Crawl the page
  const crawled = await smartScrape(item.page)

  // Step 2: Get SERP data (PAA + related searches + competitor URLs) for top queries
  const serpData = topQueries.length
    ? await batchSerpData(topQueries)
    : { organicResults: [], peopleAlsoAsk: [], relatedSearches: [] }

  // Step 3: Get keyword suggestions from primary keyword
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword)

  // Store raw data
  await updateBrief({
    crawl_data: crawled ? {
      title: crawled.title,
      description: crawled.description,
      wordCount: crawled.wordCount,
      h1: crawled.h1,
      h2: crawled.h2,
    } : null,
    serp_data: {
      organicResults: serpData.organicResults.slice(0, 5),
      peopleAlsoAsk: serpData.peopleAlsoAsk,
      relatedSearches: serpData.relatedSearches,
    },
    new_keywords: kwSuggestions.slice(0, 20),
    longtail_keywords: serpData.relatedSearches.slice(0, 15).map(r => ({
      keyword: r.query,
      intent: 'informational',
    })),
    faq_suggestions: serpData.peopleAlsoAsk.slice(0, 8).map(p => ({
      question: p.question,
      suggested_answer: p.answer ?? '',
    })),
  })

  // Step 4: Claude analysis + draft
  const prompt = buildOnPagePrompt({
    page: item.page,
    primaryKeyword,
    gscQueries,
    crawledContent: crawled?.markdown?.slice(0, 6000) ?? '',
    crawledTitle: crawled?.title ?? '',
    crawledDescription: crawled?.description ?? '',
    h2s: crawled?.h2 ?? [],
    competitors: serpData.organicResults.slice(0, 5),
    paa: serpData.peopleAlsoAsk.slice(0, 8),
    relatedSearches: serpData.relatedSearches.slice(0, 12),
    kwSuggestions: kwSuggestions.slice(0, 15),
    itemNotes: item.notes ?? '',
    kb,
    lang,
    selectedKeywords,
    customInstructions,
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''

  // Parse structured sections from Claude's response
  const sections = parseClaudeOnPageResponse(rawText)

  // Apply DMCA replacements to the content draft
  const cleanDraft = kb.dmcaTerms.length
    ? applyDmcaReplacements(sections.draft, kb.dmcaTerms)
    : sections.draft

  await updateBrief({
    status: 'draft',
    current_content_summary: sections.currentSummary,
    content_gaps: sections.contentGaps,
    content_outline: sections.outline,
    content_draft: cleanDraft,
  })
}

// ─── OFF-PAGE Pipeline ─────────────────────────────────────────────────────────
async function runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, contentTypeConfig, kb, lang, customInstructions }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  contentTypeConfig?: ContentTypeConfig
  kb: KBContext
  lang: PageLanguage
  customInstructions?: string
}) {
  // Derive topic from URL
  const topic = deriveTopicFromUrl(item.page)

  // Step 1: SERP for main keyword + topic
  const serpData = await batchSerpData([primaryKeyword, topic].filter(Boolean))

  // Step 2: Keyword suggestions for off-page content ideas
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword)

  await updateBrief({
    topic,
    serp_data: {
      organicResults: serpData.organicResults.slice(0, 8),
      peopleAlsoAsk: serpData.peopleAlsoAsk,
      relatedSearches: serpData.relatedSearches,
    },
  })

  // Step 3: Claude — analyze + generate content ideas + draft
  const prompt = buildOffPagePrompt({
    page: item.page,
    topic,
    primaryKeyword,
    gscQueries,
    competitors: serpData.organicResults.slice(0, 8),
    paa: serpData.peopleAlsoAsk.slice(0, 8),
    relatedSearches: serpData.relatedSearches.slice(0, 12),
    kwSuggestions: kwSuggestions.slice(0, 15),
    itemNotes: item.notes ?? '',
    contentTypeConfig,
    kb,
    lang,
    customInstructions,
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''
  const sections = parseClaudeOffPageResponse(rawText)

  // Tag forum ideas with the requested format (short/long) so draft generation knows which style to use
  const forumFormat = contentTypeConfig?.forum?.format ?? 'short'
  const taggedIdeas = sections.contentIdeas.map(idea =>
    idea.content_type === 'forum' ? { ...idea, format: forumFormat } : idea
  )

  await updateBrief({
    status: 'draft',
    competitor_analysis: serpData.organicResults.slice(0, 5).map(r => ({
      url: r.url,
      title: r.title,
      angle: r.description,
    })),
    content_ideas: taggedIdeas,
    // off_page_draft stores the internal link strategy (global, not per content type)
    off_page_draft: sections.internalLinkStrategy,
  })
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildOnPagePrompt(p: {
  page: string
  primaryKeyword: string
  gscQueries: any[]
  crawledContent: string
  crawledTitle: string
  crawledDescription: string
  h2s: string[]
  competitors: any[]
  paa: any[]
  relatedSearches: any[]
  kwSuggestions: any[]
  itemNotes: string
  kb: KBContext
  lang: PageLanguage
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  const gameName = deriveTopicFromUrl(p.page)
  const categoryInstructions = buildCategoryInstructions(p.page, gameName, p.primaryKeyword)
  const categoryTemplate = detectCategory(p.page)
  const hasCategoryTemplate = !!categoryTemplate

  const today = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace platform. Your job is to REFRESH and UPDATE an existing category page that has experienced a ranking drop — NOT to rewrite it from scratch.

REFRESH MINDSET: The goal is targeted improvement. Preserve what is already working. Add what is missing. Update what is outdated. Only replace sections where the current content is significantly weaker than competitors or factually stale. Think: "what is the minimum set of changes that will recover and improve this page's ranking?"

CURRENT DATE: ${today}
${p.lang.instruction ? `\n${p.lang.instruction}\n` : ''}
PAGE URL: ${p.page}
PAGE LANGUAGE: ${p.lang.name}
PRIMARY KEYWORD (from GSC, highest clicks): ${p.primaryKeyword}
GAME/PRODUCT NAME: ${gameName}

GSC QUERIES (keywords this page ranks for, by clicks):
${p.gscQueries.map(q => `- "${q.query}" | clicks: ${q.clicks} | pos: ${q.position?.toFixed(1)}`).join('\n')}

CURRENT PAGE CONTENT:
Title: ${p.crawledTitle}
Meta Description: ${p.crawledDescription}
H2 headings: ${p.h2s.join(', ') || 'none found'}
Content excerpt:
${p.crawledContent || '(could not crawl page)'}

TOP COMPETITORS RANKING FOR "${p.primaryKeyword}":
${p.competitors.map((c, i) => `${i + 1}. ${c.title} — ${c.url}\n   ${c.description}`).join('\n')}

PEOPLE ALSO ASK (potential FAQ topics):
${p.paa.map(q => `- ${q.question}`).join('\n')}

RELATED SEARCHES (long-tail opportunities):
${p.relatedSearches.map(r => `- ${r.query}`).join('\n')}

${p.selectedKeywords && p.selectedKeywords.filter(Boolean).length > 0 ? `
FOCUS KEYWORDS (hand-picked by editor — prioritise these above all others in the draft):
${p.selectedKeywords.filter(Boolean).map(k => `- ${k}`).join('\n')}
` : ''}
KEYWORD SUGGESTIONS (volume from DataForSEO — use for additional coverage):
${p.kwSuggestions.map(k => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'} | CPC: $${k.cpc ?? '?'}`).join('\n')}

EDITOR NOTES: ${p.itemNotes || 'none'}

---
${hasCategoryTemplate ? `
G2G CATEGORY CONTENT TEMPLATE (MUST FOLLOW):
This page follows G2G's official content structure for this category.
${categoryInstructions}
` : ''}${buildKBBlock(p.kb, true)}
---

${p.customInstructions?.trim() ? `CUSTOM EDITOR INSTRUCTIONS (override defaults where relevant):\n${p.customInstructions.trim()}\n\n` : ''}Now provide your analysis and refresh plan with these EXACT sections:

## CURRENT CONTENT SUMMARY
2-3 sentences focused ONLY on substance — not formatting, HTML structure, or meta tags. Cover: (1) what topics and data points the page currently addresses, (2) its depth vs top competitors, (3) what is already working that should be kept. Do not mention page layout or technical formatting.

## CONTENT GAPS
3-5 specific topical gaps — subjects, questions, use cases, or data points that competitors cover but this page does not. For each gap, specify whether it's a missing section, outdated info, or thin coverage. Focus on substance, not structure.

## FRESHNESS OPPORTUNITIES
2-3 specific ways to make this content feel current as of ${today}:
- Any game updates, new features, or meta changes relevant to "${gameName}" that should be mentioned
- Seasonal or trending search angles to incorporate
- Outdated claims or figures in the current content that need updating
If nothing specific is known, suggest adding "Last updated" signals and recency markers.

## RECOMMENDED KEYWORDS
5-8 high-value keywords to add or strengthen (from the suggestions above + PAA data). Format: keyword | search intent | priority (high/medium)

## CONTENT OUTLINE
${hasCategoryTemplate
  ? 'Follow the G2G category template sections above exactly. Mark which sections need updating vs which can stay as-is.'
  : 'Propose the refreshed H2/H3 structure. For each section: keep / update / add — and briefly explain why.'}

## FAQ SECTION
${hasCategoryTemplate
  ? 'Write 5-6 Q&A pairs focused on: ' + (categoryTemplate?.faqFocus ?? 'buyer safety, delivery, refunds')
  : 'Write 5-6 Q&A pairs based on People Also Ask data. Prioritise questions not already answered on the page.'}

## CONTENT DRAFT
Write the refreshed, publish-ready content draft. This is a content UPDATE — preserve the page's existing strengths, enrich with missing topics, and ensure freshness.
${hasCategoryTemplate ? `
CRITICAL: Follow the G2G category template structure EXACTLY:
- Use HTML format with <br><br> between paragraphs (NO <p> tags)
- Follow the exact H1 format: ${categoryInstructions.match(/H1 format: (.+)/)?.[1] ?? ''}
- Include {{trending_games}} placeholder in the Trending Products section
- Follow keyword density rules from the template
- Follow all writing rules and forbidden words from the template
- Write the FULL draft including ALL sections from the template
` : 'Aim for 800-1200 words. Weave in the target keyword and long-tail variants naturally. Do not pad with filler content.'}
Also output:
META TITLE: (≤60 chars)
META DESCRIPTION: (≤110 chars)`
}

function buildOffPagePrompt(p: {
  page: string
  topic: string
  primaryKeyword: string
  gscQueries: any[]
  competitors: any[]
  paa: any[]
  relatedSearches: any[]
  kwSuggestions: any[]
  itemNotes: string
  contentTypeConfig?: ContentTypeConfig
  kb: KBContext
  lang: PageLanguage
  customInstructions?: string
}) {
  // Resolve which content types to include and how many ideas each
  const cfg = p.contentTypeConfig ?? {
    blog_post: { enabled: true,  count: 2 },
    forum:     { enabled: true,  count: 2 },
    social:    { enabled: false, count: 1 },
  }

  const blogEnabled   = cfg.blog_post?.enabled ?? true
  const forumEnabled  = cfg.forum?.enabled     ?? true
  const socialEnabled = cfg.social?.enabled    ?? false
  const blogCount     = cfg.blog_post?.count   ?? 2
  const forumCount    = cfg.forum?.count       ?? 2
  const socialCount   = cfg.social?.count      ?? 1

  // Build dynamic sections — ideas only (drafts are generated on-demand per idea)
  const contentSections = [
    blogEnabled && `## BLOG / ARTICLE IDEAS
List ${blogCount} blog post or long-form article idea${blogCount > 1 ? 's' : ''} suitable for G2G's blog, Medium, or gaming publications.
For each use EXACTLY this format (one per line starting with the field name):
- Title: [idea title]
- Angle: [hook or unique angle]
- Target keyword: [1 keyword]
- Platform: [Blog / Medium / Gaming publication]
- Why: [1 sentence on how this helps the target page rank]`,

    forumEnabled && `## FORUM / COMMUNITY IDEAS
List ${forumCount} community content idea${forumCount > 1 ? 's' : ''} for Reddit, Discord, or gaming forums.
For each use EXACTLY this format:
- Title: [thread or post title]
- Angle: [hook]
- Target keyword: [1 keyword]
- Platform: [e.g. Reddit r/gaming, Discord, GameFAQs]
- Why: [1 sentence on how this helps]`,

    socialEnabled && `## SOCIAL MEDIA IDEAS
List ${socialCount} social media content idea${socialCount > 1 ? 's' : ''} for Twitter/X, Instagram, TikTok, or YouTube.
For each use EXACTLY this format:
- Title: [hook or topic]
- Format: [Twitter thread / TikTok script / Instagram carousel / YouTube description]
- Target keyword: [1 keyword]
- Platform: [platform name]
- Why: [1 sentence on how this helps]`,
  ].filter(Boolean).join('\n\n')

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace platform. You are creating an off-page content plan to support a category page that has experienced a ranking drop.
${p.lang.instruction ? `\n${p.lang.instruction}\n` : ''}
TARGET PAGE: ${p.page}
PAGE LANGUAGE: ${p.lang.name}
TOPIC: ${p.topic}
PRIMARY KEYWORD: ${p.primaryKeyword}

GSC QUERIES (what this page already ranks for):
${p.gscQueries.map(q => `- "${q.query}" | clicks: ${q.clicks} | pos: ${q.position?.toFixed(1)}`).join('\n')}

CURRENT SERP LANDSCAPE (who's ranking):
${p.competitors.map((c, i) => `${i + 1}. ${c.title}\n   ${c.url}\n   ${c.description}`).join('\n\n')}

PEOPLE ALSO ASK:
${p.paa.map(q => `- ${q.question}`).join('\n')}

RELATED SEARCHES:
${p.relatedSearches.map(r => `- ${r.query}`).join('\n')}

KEYWORD IDEAS:
${p.kwSuggestions.map(k => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'}`).join('\n')}

EDITOR NOTES: ${p.itemNotes || 'none'}
${buildKBBlock(p.kb, false)}
---
${p.customInstructions?.trim() ? `\nCUSTOM EDITOR INSTRUCTIONS (override defaults where relevant):\n${p.customInstructions.trim()}\n` : ''}
Provide an off-page content plan with these EXACT sections in this exact order:

## COMPETITOR ANALYSIS
Analyze what angles the top competitors are using. What content formats are working? What gaps exist that G2G can own?

${contentSections}

## INTERNAL LINK STRATEGY
List 3-5 pages already on G2G.com that should link to ${p.page}, with the suggested anchor text for each.`
}

// ─── Response parsers ─────────────────────────────────────────────────────────

function parseClaudeOnPageResponse(text: string) {
  const get = (header: string) => {
    const re = new RegExp(`## ${header}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i')
    return text.match(re)?.[1]?.trim() ?? ''
  }

  const gapsRaw = get('CONTENT GAPS')
  const contentGaps = gapsRaw.split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim())

  const outlineRaw = get('CONTENT OUTLINE')
  const outline = outlineRaw.split('\n').filter(Boolean).map(line => ({ text: line.trim() }))

  const faqRaw = get('FAQ SECTION')
  // FAQ is embedded in faq_suggestions — already set from PAA data; the draft will include it too

  return {
    currentSummary: get('CURRENT CONTENT SUMMARY'),
    contentGaps,
    outline,
    draft: [get('CONTENT DRAFT'), get('FAQ SECTION')].filter(Boolean).join('\n\n---\n\n## FAQ\n\n'),
  }
}

function parseClaudeOffPageResponse(text: string) {
  const get = (header: string) => {
    // Escape special regex chars in header
    const escaped = header.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
    const re = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i')
    return text.match(re)?.[1]?.trim() ?? ''
  }

  // Parse a block of ideas formatted with "- Field: value" lines
  function parseIdeas(raw: string, contentType: 'blog_post' | 'forum' | 'social'): ContentIdea[] {
    if (!raw) return []
    // Split into per-idea blocks (each starts with "- Title:")
    const blocks = raw.split(/\n(?=-\s*Title:)/i).filter(Boolean)
    return blocks.map(block => {
      const titleMatch   = block.match(/Title:\s*(.+)/i)
      const platformMatch = block.match(/Platform:\s*(.+)/i)
      const kwMatch      = block.match(/Target keyword:\s*(.+)/i)
      const angleMatch   = block.match(/(?:Angle|Format|Hook):\s*(.+)/i)
      const whyMatch     = block.match(/Why:\s*(.+)/i)
      return {
        content_type: contentType,
        title: titleMatch?.[1]?.trim() ?? '',
        platform: platformMatch?.[1]?.trim() ?? '',
        target_keyword: kwMatch?.[1]?.trim() ?? '',
        notes: [angleMatch?.[1]?.trim(), whyMatch?.[1]?.trim()].filter(Boolean).join(' | '),
      } as ContentIdea
    }).filter(idea => idea.title)
  }

  const blogIdeas   = parseIdeas(get('BLOG / ARTICLE IDEAS'),    'blog_post')
  const forumIdeas  = parseIdeas(get('FORUM / COMMUNITY IDEAS'), 'forum')
  const socialIdeas = parseIdeas(get('SOCIAL MEDIA IDEAS'),      'social')

  return {
    competitorAnalysis: get('COMPETITOR ANALYSIS'),
    contentIdeas: [...blogIdeas, ...forumIdeas, ...socialIdeas],
    internalLinkStrategy: get('INTERNAL LINK STRATEGY'),
  }
}

export type ContentIdea = {
  content_type: 'blog_post' | 'forum' | 'social'
  title: string
  platform: string
  target_keyword: string
  notes: string
  format?: 'short' | 'long'   // forum only: 'short' = 50-150 word native Reddit post, 'long' = 300-500 word thread
  draft?: string
  draft_status?: 'generating' // set while background draft generation is running
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deriveTopicFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname
    // e.g. /categories/fortnite-items → "fortnite items"
    const slug = path.split('/').filter(Boolean).pop() ?? ''
    return slug.replace(/-/g, ' ').replace(/_/g, ' ')
  } catch {
    return ''
  }
}
