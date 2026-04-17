import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { smartScrape } from '@/lib/firecrawl/client'
import { batchSerpData, getKeywordSuggestions } from '@/lib/dataforseo/client'
import { buildCategoryInstructions, detectCategory } from '@/lib/g2g-category-prompts'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 120 // briefs take time

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── POST /api/brief/generate ─────────────────────────────────────────────────
// Body: { action_item_id: string }
// Generates an on-page or off-page brief for the given action item,
// using Firecrawl (page crawl) + DataForSEO (SERP/PAA/keywords) + Claude (analysis + draft)

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', user.id)
    .single()
  if (!conn?.site_url) return NextResponse.json({ error: 'No GSC connection' }, { status: 400 })

  const { action_item_id } = await request.json()
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

  // ── Run pipeline async — don't block the response ──────────────────────────
  // Return brief ID immediately so the UI can poll for status
  runBriefPipeline(brief.id, item, topQueries, primaryKeyword, conn.site_url, gscQueries ?? []).catch(err =>
    console.error('Brief pipeline error:', err)
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

// ─── Pipeline ─────────────────────────────────────────────────────────────────
async function runBriefPipeline(
  briefId: string,
  item: any,
  topQueries: string[],
  primaryKeyword: string,
  siteUrl: string,
  gscQueries: any[]
) {
  const supabase_server = (await import('@/lib/supabase/server')).createClient
  const supabase = await supabase_server()

  async function updateBrief(fields: Record<string, unknown>) {
    await supabase.from('seo_content_briefs').update(fields).eq('id', briefId)
  }

  try {
    if (item.action_type === 'on_page') {
      await runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief })
    } else {
      await runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief })
    }
  } catch (err) {
    console.error('Pipeline failed:', err)
    await updateBrief({ status: 'draft', content_draft: `Pipeline error: ${err}` })
  }
}

// ─── ON-PAGE Pipeline ──────────────────────────────────────────────────────────
async function runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
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
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''

  // Parse structured sections from Claude's response
  const sections = parseClaudeOnPageResponse(rawText)

  await updateBrief({
    status: 'draft',
    current_content_summary: sections.currentSummary,
    content_gaps: sections.contentGaps,
    content_outline: sections.outline,
    content_draft: sections.draft,
  })
}

// ─── OFF-PAGE Pipeline ─────────────────────────────────────────────────────────
async function runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
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
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })

  const rawText = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''
  const sections = parseClaudeOffPageResponse(rawText)

  await updateBrief({
    status: 'draft',
    competitor_analysis: serpData.organicResults.slice(0, 5).map(r => ({
      url: r.url,
      title: r.title,
      angle: r.description,
    })),
    content_ideas: sections.contentIdeas,
    off_page_draft: sections.draft,
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
}) {
  const gameName = deriveTopicFromUrl(p.page)
  const categoryInstructions = buildCategoryInstructions(p.page, gameName, p.primaryKeyword)
  const categoryTemplate = detectCategory(p.page)
  const hasCategoryTemplate = !!categoryTemplate

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace platform. You are analyzing a category page that has experienced a ranking drop and needs full content optimization.

PAGE URL: ${p.page}
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

KEYWORD SUGGESTIONS (volume from DataForSEO):
${p.kwSuggestions.map(k => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'} | CPC: $${k.cpc ?? '?'}`).join('\n')}

EDITOR NOTES: ${p.itemNotes || 'none'}

---
${hasCategoryTemplate ? `
G2G CATEGORY CONTENT TEMPLATE (MUST FOLLOW):
This page follows G2G's official content structure for this category.
${categoryInstructions}
` : ''}
---

Now provide your analysis and draft with these EXACT sections:

## CURRENT CONTENT SUMMARY
2-3 sentences: what the page currently covers and its main weaknesses vs competitors.

## CONTENT GAPS
3-5 specific gaps vs competitors (what they cover that this page misses).

## RECOMMENDED KEYWORDS
5-8 high-value keywords to add or strengthen. Format: keyword | search intent | priority

## CONTENT OUTLINE
${hasCategoryTemplate ? 'Follow the G2G category template sections above exactly.' : 'Propose an improved H2/H3 structure with notes on what each section should cover.'}

## FAQ SECTION
${hasCategoryTemplate ? 'Write 5-6 Q&A pairs focused on: ' + (categoryTemplate?.faqFocus ?? 'buyer safety, delivery, refunds') : 'Write 5-6 Q&A pairs based on People Also Ask data.'}

## CONTENT DRAFT
Write a complete, publish-ready content draft.
${hasCategoryTemplate ? `
CRITICAL: Follow the G2G category template structure EXACTLY:
- Use HTML format with <br><br> between paragraphs (NO <p> tags)
- Follow the exact H1 format: ${categoryInstructions.match(/H1 format: (.+)/)?.[1] ?? ''}
- Include {{trending_games}} placeholder in the Trending Products section
- Follow keyword density rules from the template
- Follow all writing rules and forbidden words from the template
- Write the FULL draft including ALL sections from the template
` : 'Aim for 800-1200 words. Include natural keyword placement.'}
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
}) {
  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace platform. You are creating an off-page content plan to support a category page that has experienced a ranking drop.

TARGET PAGE: ${p.page}
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

---

Provide an off-page content plan with these EXACT sections:

## COMPETITOR ANALYSIS
Analyze what angles competitors are using. What content types are working? What gaps exist that G2G can own?

## CONTENT IDEAS
List 4-5 off-page content ideas. For each, provide:
- Title
- Content angle / hook
- Target keyword
- Recommended platform (e.g. blog, Reddit, Medium, gaming forum, YouTube script, guest post)
- Why this will help the target page rank higher

## CONTENT DRAFT
Write a complete, publish-ready draft for the HIGHEST PRIORITY content idea from above. This should be the full article/post — not a placeholder. Aim for 600-1000 words. Include internal link suggestion back to ${p.page}.

## INTERNAL LINK STRATEGY
Suggest 3-5 other pages on G2G.com that should link to the target page, with suggested anchor texts.`
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
    const re = new RegExp(`## ${header}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i')
    return text.match(re)?.[1]?.trim() ?? ''
  }

  const ideasRaw = get('CONTENT IDEAS')
  // Parse ideas — each is a block starting with "- Title:" or numbered
  const ideaBlocks = ideasRaw.split(/\n(?=\d+\.|-)/).filter(Boolean)
  const contentIdeas = ideaBlocks.map(block => {
    const titleMatch = block.match(/(?:Title|^\d+\.|^-)\s*[:\.]?\s*(.+)/i)
    const platformMatch = block.match(/platform[:\s]+(.+)/i)
    const kwMatch = block.match(/(?:target keyword|keyword)[:\s]+(.+)/i)
    return {
      title: titleMatch?.[1]?.trim() ?? block.split('\n')[0].replace(/^[\-\d\.]\s*/, '').trim(),
      platform: platformMatch?.[1]?.trim() ?? '',
      target_keyword: kwMatch?.[1]?.trim() ?? '',
      notes: block,
    }
  })

  return {
    competitorAnalysis: get('COMPETITOR ANALYSIS'),
    contentIdeas,
    draft: [get('CONTENT DRAFT'), get('INTERNAL LINK STRATEGY')].filter(Boolean).join('\n\n---\n\n'),
  }
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
