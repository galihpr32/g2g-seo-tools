import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { smartScrape } from '@/lib/firecrawl/client'
import { batchSerpData, getKeywordSuggestions } from '@/lib/dataforseo/client'
import { buildCategoryInstructions, detectCategory } from '@/lib/g2g-category-prompts'
import { detectPageLanguage, type PageLanguage } from '@/lib/language-detect'
import { countryFromLanguageCode, getCountryPreset, type CountryPreset } from '@/lib/country-config'
import { logApiUsage } from '@/lib/api-logger'
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
  const db = createServiceClient()

  // Resolve active site from cookie
  const cookieSite = request.headers.get('cookie')?.match(/active-site=([^;]+)/)?.[1] ?? 'g2g'

  // Sprint 12: site_url ONLY from site_configs based on active slug.
  // No fallback to gsc_connections.site_url (always returned G2G's URL).
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', cookieSite)
    .eq('is_active', true)
    .maybeSingle()

  // Verify GSC OAuth is connected (tokens shared across sites under same Google account)
  const { data: conn } = await db
    .from('gsc_connections')
    .select('user_id')
    .eq('user_id', effectiveOwnerId)
    .maybeSingle()

  const resolvedSiteUrl = (conn && siteConfig?.gsc_property) ? siteConfig.gsc_property : null
  if (!resolvedSiteUrl) return NextResponse.json({ error: `No GSC data for site=${cookieSite}` }, { status: 400 })

  const reqBody = await request.json()
  const { action_item_id, content_type_config, selected_keywords, custom_instructions, serp_country } = reqBody as {
    action_item_id: string
    content_type_config?: Record<string, { enabled: boolean; count: number; format?: 'short' | 'long' }>
    selected_keywords?: string[]   // user-curated keywords from pre-generate step
    custom_instructions?: string   // editor-supplied freeform instructions
    serp_country?: string          // ISO2 country code override for SERP data (default: auto from page URL)
  }
  if (!action_item_id) return NextResponse.json({ error: 'Missing action_item_id' }, { status: 400 })

  // Load the action item
  const { data: item } = await db
    .from('seo_action_items')
    .select('*')
    .eq('id', action_item_id)
    .single()
  if (!item) return NextResponse.json({ error: 'Action item not found' }, { status: 404 })

  // Load GSC queries for this page (already stored from ranking drop)
  const { data: gscQueries } = await supabase
    .from('gsc_ranking_drop_queries')
    .select('query, clicks, impressions, ctr, position')
    .eq('site_url', resolvedSiteUrl)
    .eq('page', item.page)
    .order('clicks', { ascending: false })
    .limit(10)

  const topQueries = (gscQueries ?? []).map(q => q.query)
  const primaryKeyword = topQueries[0] ?? deriveTopicFromUrl(item.page)

  // ── Create initial DB record (status: generating) ─────────────────────────
  const { data: brief, error: insertErr } = await supabase
    .from('seo_content_briefs')
    .insert({
      site_url:        resolvedSiteUrl,
      site_slug:       cookieSite,
      action_item_id,
      page:            item.page,
      // brief_type stays as the legacy on_page/off_page split for back-compat
      // (existing UI filters on it). output_type below is the new driver.
      brief_type:      item.action_type,
      output_type:     item.output_type ?? null,
      status:          'generating',
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
    runBriefPipeline(brief.id, item, topQueries, primaryKeyword, resolvedSiteUrl, gscQueries ?? [], content_type_config, selected_keywords, custom_instructions, serp_country)
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
  uspsOnPage: string[]    // on-page USPs for {usps} placeholder
  uspsOffPage: string[]   // off-page USPs for outreach prompts
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
    dmcaTerms: [], uspsOnPage: [], uspsOffPage: [],
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uspsOnPage: (kbItems as any[])
        .filter((i: any) => i.category === 'usp' && ['on_page', 'both'].includes((i.data as Record<string,unknown>).usage_type as string ?? 'on_page'))
        .map((i: any) => `- ${i.name}${i.data?.description ? ': ' + i.data.description : ''}`),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      uspsOffPage: (kbItems as any[])
        .filter((i: any) => i.category === 'usp' && ['off_page', 'both'].includes((i.data as Record<string,unknown>).usage_type as string ?? 'on_page'))
        .map((i: any) => `- ${i.name}${i.data?.description ? ': ' + i.data.description : ''}`),
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
  customInstructions?: string,
  serpCountryCode?: string
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
          dmcaTerms: [], uspsOnPage: [], uspsOffPage: [] }

    // Detect language from the target page URL
    const lang = detectPageLanguage(item.page)
    // Resolve SERP country: explicit override > language-auto-detected > Indonesia default
    const country: CountryPreset = serpCountryCode
      ? getCountryPreset(serpCountryCode)
      : countryFromLanguageCode(lang.code)

    // ── Route by output_type (preferred) → action_type (legacy fallback) ────
    // output_type is the source of truth (set when the opportunity / action
    // item was created via pipeline-journey / keyword-gap / competitive flows).
    // For rows that pre-date Sprint BRAGI.1, derive from action_type so they
    // keep working until the next backfill pass.
    const outputType: 'new_page' | 'optimize_existing' | 'blog_post' | 'outreach' =
      ['new_page', 'optimize_existing', 'blog_post', 'outreach'].includes(item.output_type)
        ? item.output_type
        : item.action_type === 'on_page' ? 'optimize_existing'
        : item.action_type === 'off_page' ? 'outreach'
        : 'optimize_existing'

    if (outputType === 'optimize_existing') {
      await runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions })
    } else if (outputType === 'new_page') {
      await runNewPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions })
    } else if (outputType === 'blog_post') {
      await runBlogPostPipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions })
    } else {
      await runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, contentTypeConfig, kb, lang, country, customInstructions })
    }

    // Log API usage (fire-and-forget)
    if (ownerId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any
      logApiUsage(sb, ownerId, { api: 'firecrawl', endpoint: 'scrape', triggeredBy: 'brief_generate', metadata: { page: item.page } })
      logApiUsage(sb, ownerId, { api: 'dataforseo', endpoint: 'serp/google/organic', triggeredBy: 'brief_generate', callCount: topQueries.length || 1, metadata: { page: item.page } })
      logApiUsage(sb, ownerId, { api: 'dataforseo', endpoint: 'keywords_data/google/suggestions', triggeredBy: 'brief_generate', metadata: { keyword: primaryKeyword } })
      logApiUsage(sb, ownerId, { api: 'claude', endpoint: 'messages', triggeredBy: 'brief_generate', metadata: { model: 'claude-opus-4-6', action_type: item.action_type, output_type: outputType } })
    }
  } catch (err) {
    console.error('Pipeline failed:', err)
    await updateBrief({ status: 'draft', content_draft: `Pipeline error: ${err}` })
  }
}

// ─── ON-PAGE Pipeline ──────────────────────────────────────────────────────────
async function runOnPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  // Step 1: Crawl the page
  const crawled = await smartScrape(item.page)

  // Step 2: Get SERP data (PAA + related searches + competitor URLs) for top queries
  const serpData = topQueries.length
    ? await batchSerpData(topQueries, country.dfsLocationCode, country.dfsLanguageCode)
    : { organicResults: [], peopleAlsoAsk: [], relatedSearches: [] }

  // Step 3: Get keyword suggestions from primary keyword
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword, country.dfsLocationCode, country.dfsLanguageCode)

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
    country,
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

// ─── NEW-PAGE Pipeline ─────────────────────────────────────────────────────
// For output_type='new_page' — page doesn't exist yet, no crawl. Build from
// scratch using SERP + competitor analysis. Different prompt explicitly tells
// the AI to design a fresh category/landing page, not refresh an old one.
async function runNewPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions }: {
  briefId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any
  topQueries: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gscQueries: any[]
  primaryKeyword: string
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  // No crawl — page doesn't exist. Go straight to SERP + keyword research.
  const serpData = topQueries.length
    ? await batchSerpData(topQueries, country.dfsLocationCode, country.dfsLanguageCode)
    : await batchSerpData([primaryKeyword], country.dfsLocationCode, country.dfsLanguageCode)
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword, country.dfsLocationCode, country.dfsLanguageCode)

  await updateBrief({
    crawl_data: null,   // explicit: no crawl for new page
    serp_data: {
      organicResults:  serpData.organicResults.slice(0, 5),
      peopleAlsoAsk:   serpData.peopleAlsoAsk,
      relatedSearches: serpData.relatedSearches,
    },
    new_keywords:    kwSuggestions.slice(0, 20),
    longtail_keywords: serpData.relatedSearches.slice(0, 15).map(r => ({ keyword: r.query, intent: 'informational' })),
    faq_suggestions: serpData.peopleAlsoAsk.slice(0, 8).map(p => ({ question: p.question, suggested_answer: p.answer ?? '' })),
  })

  const prompt = buildNewPagePrompt({
    page: item.page, primaryKeyword, gscQueries,
    competitors: serpData.organicResults.slice(0, 5),
    paa: serpData.peopleAlsoAsk.slice(0, 8),
    relatedSearches: serpData.relatedSearches.slice(0, 12),
    kwSuggestions: kwSuggestions.slice(0, 15),
    itemNotes: item.notes ?? '',
    kb, lang, country, selectedKeywords, customInstructions,
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  const rawText  = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''
  const sections = parseClaudeOnPageResponse(rawText)
  const cleanDraft = kb.dmcaTerms.length ? applyDmcaReplacements(sections.draft, kb.dmcaTerms) : sections.draft

  await updateBrief({
    status: 'draft',
    current_content_summary: sections.currentSummary,    // will say "N/A — new page"
    content_gaps:    sections.contentGaps,
    content_outline: sections.outline,
    content_draft:   cleanDraft,
  })
}

// ─── BLOG-POST Pipeline ────────────────────────────────────────────────────
// For output_type='blog_post' — editorial content (how-to, listicle, guide,
// trend piece). Different structure than category page: long-form, TOC,
// embedded internal links to product pages, less commercial pressure.
async function runBlogPostPipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, kb, lang, country, selectedKeywords, customInstructions }: {
  briefId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any
  topQueries: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gscQueries: any[]
  primaryKeyword: string
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  const serpData = topQueries.length
    ? await batchSerpData(topQueries, country.dfsLocationCode, country.dfsLanguageCode)
    : await batchSerpData([primaryKeyword], country.dfsLocationCode, country.dfsLanguageCode)
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword, country.dfsLocationCode, country.dfsLanguageCode)

  await updateBrief({
    crawl_data: null,
    serp_data: {
      organicResults:  serpData.organicResults.slice(0, 5),
      peopleAlsoAsk:   serpData.peopleAlsoAsk,
      relatedSearches: serpData.relatedSearches,
    },
    new_keywords:    kwSuggestions.slice(0, 20),
    longtail_keywords: serpData.relatedSearches.slice(0, 15).map(r => ({ keyword: r.query, intent: 'informational' })),
    faq_suggestions: serpData.peopleAlsoAsk.slice(0, 8).map(p => ({ question: p.question, suggested_answer: p.answer ?? '' })),
  })

  const prompt = buildBlogPostPrompt({
    page: item.page, primaryKeyword, gscQueries,
    competitors: serpData.organicResults.slice(0, 5),
    paa: serpData.peopleAlsoAsk.slice(0, 8),
    relatedSearches: serpData.relatedSearches.slice(0, 12),
    kwSuggestions: kwSuggestions.slice(0, 15),
    itemNotes: item.notes ?? '',
    kb, lang, country, selectedKeywords, customInstructions,
  })

  const aiResponse = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  })
  const rawText  = aiResponse.content[0].type === 'text' ? aiResponse.content[0].text : ''
  const sections = parseClaudeOnPageResponse(rawText)
  const cleanDraft = kb.dmcaTerms.length ? applyDmcaReplacements(sections.draft, kb.dmcaTerms) : sections.draft

  await updateBrief({
    status: 'draft',
    current_content_summary: sections.currentSummary,
    content_gaps:    sections.contentGaps,
    content_outline: sections.outline,
    content_draft:   cleanDraft,
  })
}

// ─── OFF-PAGE Pipeline ─────────────────────────────────────────────────────────
async function runOffPagePipeline({ briefId, item, topQueries, primaryKeyword, gscQueries, updateBrief, contentTypeConfig, kb, lang, country, customInstructions }: {
  briefId: string
  item: any
  topQueries: string[]
  primaryKeyword: string
  gscQueries: any[]
  updateBrief: (f: Record<string, unknown>) => Promise<void>
  contentTypeConfig?: ContentTypeConfig
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  customInstructions?: string
}) {
  // Derive topic from URL
  const topic = deriveTopicFromUrl(item.page)

  // Step 1: SERP for main keyword + topic
  const serpData = await batchSerpData([primaryKeyword, topic].filter(Boolean), country.dfsLocationCode, country.dfsLanguageCode)

  // Step 2: Keyword suggestions for off-page content ideas
  const kwSuggestions = await getKeywordSuggestions(primaryKeyword, country.dfsLocationCode, country.dfsLanguageCode)

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
    country,
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
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  const gameName = deriveTopicFromUrl(p.page)
  const categoryInstructions = buildCategoryInstructions(p.page, gameName, p.primaryKeyword, p.kb.uspsOnPage)
  const categoryTemplate = detectCategory(p.page)
  const hasCategoryTemplate = !!categoryTemplate

  const today = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace platform. Your job is to REFRESH and UPDATE an existing category page that has experienced a ranking drop — NOT to rewrite it from scratch.

REFRESH MINDSET: The goal is targeted improvement. Preserve what is already working. Add what is missing. Update what is outdated. Only replace sections where the current content is significantly weaker than competitors or factually stale. Think: "what is the minimum set of changes that will recover and improve this page's ranking?"

CURRENT DATE: ${today}
${p.lang.instruction ? `\n${p.lang.instruction}\n` : ''}
PAGE URL: ${p.page}
PAGE LANGUAGE: ${p.lang.name}
SERP COUNTRY: ${p.country.flag} ${p.country.label} (SERP data pulled for this market)
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

// ─── buildNewPagePrompt — for output_type='new_page' ─────────────────────
// This is for CREATING a category/landing page from scratch when none exists.
// Critically different from buildOnPagePrompt: no crawl, no "preserve existing
// content" framing — the AI is told to design a brand-new page.
function buildNewPagePrompt(p: {
  page: string
  primaryKeyword: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gscQueries: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  competitors: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paa: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relatedSearches: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kwSuggestions: any[]
  itemNotes: string
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  const gameName = deriveTopicFromUrl(p.page)
  const categoryInstructions = buildCategoryInstructions(p.page, gameName, p.primaryKeyword, p.kb.uspsOnPage)
  const categoryTemplate = detectCategory(p.page)
  const hasCategoryTemplate = !!categoryTemplate
  const today = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  return `You are an expert SEO content strategist for G2G.com, a gaming marketplace. Your job is to DESIGN A NEW CATEGORY/LANDING PAGE FROM SCRATCH — this page does NOT exist yet.

NEW-PAGE MINDSET: No existing content to preserve. The user has identified a keyword opportunity with strong commercial intent and wants a fresh page that can rank from day one. Lead with what buyers come here for: price comparison, listings, trust signals, immediate transaction paths. Avoid the trap of generic "What is X" intros — those rank for informational queries we don't want.

CURRENT DATE: ${today}
${p.lang.instruction ? `\n${p.lang.instruction}\n` : ''}TARGET PAGE URL (to be created): ${p.page}
PAGE LANGUAGE: ${p.lang.name}
SERP COUNTRY: ${p.country.flag} ${p.country.label} (SERP data pulled for this market)
PRIMARY KEYWORD: ${p.primaryKeyword}
GAME/PRODUCT NAME: ${gameName}

${p.gscQueries.length ? `GSC HINTS (related queries the rest of the site already ranks for):
${p.gscQueries.map(q => `- "${q.query}" | clicks: ${q.clicks} | pos: ${q.position?.toFixed(1)}`).join('\n')}
` : '_(No GSC history for this URL — this is a true greenfield launch.)_'}

TOP COMPETITORS RANKING FOR "${p.primaryKeyword}":
${p.competitors.map((c, i) => `${i + 1}. ${c.title} — ${c.url}\n   ${c.description}`).join('\n')}

PEOPLE ALSO ASK (must-answer questions on the new page):
${p.paa.map(q => `- ${q.question}`).join('\n')}

RELATED SEARCHES (long-tail to weave in):
${p.relatedSearches.map(r => `- ${r.query}`).join('\n')}

${p.selectedKeywords && p.selectedKeywords.filter(Boolean).length > 0 ? `
FOCUS KEYWORDS (hand-picked by editor — prioritise these above all others):
${p.selectedKeywords.filter(Boolean).map(k => `- ${k}`).join('\n')}
` : ''}KEYWORD SUGGESTIONS (volume from DataForSEO — for additional coverage):
${p.kwSuggestions.map(k => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'} | CPC: $${k.cpc ?? '?'}`).join('\n')}

EDITOR NOTES: ${p.itemNotes || 'none'}

---
${hasCategoryTemplate ? `
G2G CATEGORY CONTENT TEMPLATE (MUST FOLLOW for new page):
${categoryInstructions}
` : ''}${buildKBBlock(p.kb, true)}
---

${p.customInstructions?.trim() ? `CUSTOM EDITOR INSTRUCTIONS (override defaults where relevant):\n${p.customInstructions.trim()}\n\n` : ''}Now design the new page with these EXACT sections:

## CURRENT CONTENT SUMMARY
Write exactly: "N/A — this is a new page that does not exist yet."

## CONTENT GAPS
List 4-6 topical areas competitors cover that the new page MUST include from launch (price ranges, delivery time, payment methods, account safety, etc.). For each, briefly note WHY it matters for ranking + conversion.

## FRESHNESS OPPORTUNITIES
2-3 angles to launch with as of ${today}:
- Current game updates, seasonal events, or meta changes relevant to "${gameName}"
- "${today}" trending search variants worth seeding into the launch
- Any data points that will help the page age well (pricing tables, FAQ schema)

## RECOMMENDED KEYWORDS
5-8 keywords the new page should target. Format: keyword | search intent | priority (high/medium)

## CONTENT OUTLINE
${hasCategoryTemplate
  ? 'Follow the G2G category template sections above exactly. Mark each section as NEW (to be created). Do NOT mark anything as "keep" since the page does not exist.'
  : 'Propose the H2/H3 structure for the new page. 5-7 sections. First section must be transactional (listings, trust signals, price comparison) — NOT a "What is X" intro.'}

## FAQ SECTION
${hasCategoryTemplate
  ? 'Write 5-6 Q&A pairs focused on: ' + (categoryTemplate?.faqFocus ?? 'buyer safety, delivery, refunds, payment')
  : 'Write 5-6 Q&A pairs based on People Also Ask data. Cover buyer concerns: pricing, delivery, safety, refunds.'}

## CONTENT DRAFT
Write the FULL launch-ready page draft.
${hasCategoryTemplate ? `
CRITICAL: Follow the G2G category template structure EXACTLY:
- Use HTML format with <br><br> between paragraphs (NO <p> tags)
- Follow the exact H1 format: ${categoryInstructions.match(/H1 format: (.+)/)?.[1] ?? ''}
- Include {{trending_games}} placeholder in the Trending Products section
- Follow keyword density rules from the template
- Follow all writing rules and forbidden words from the template
- Write the FULL draft including ALL sections from the template
` : 'Aim for 800-1200 words. Lead with transactional intent. Use H2/H3 hierarchy. Weave in the target keyword and long-tail variants naturally — no keyword stuffing.'}
Also output:
META TITLE: (≤60 chars)
META DESCRIPTION: (≤110 chars)`
}

// ─── buildBlogPostPrompt — for output_type='blog_post' ───────────────────
// Editorial article structure — explicitly NOT a category page. Used for
// content marketing pieces (how-to, listicle, guide, news commentary).
// Emphasizes long-form depth, internal linking to product pages, less
// transactional pressure.
function buildBlogPostPrompt(p: {
  page: string
  primaryKeyword: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gscQueries: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  competitors: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paa: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relatedSearches: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kwSuggestions: any[]
  itemNotes: string
  kb: KBContext
  lang: PageLanguage
  country: CountryPreset
  selectedKeywords?: string[]
  customInstructions?: string
}) {
  const today = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

  // Detect article format by primary-keyword shape (informational signal).
  // "how to ...", "best ...", "guide ...", "vs", "review" → pick the closest.
  const kwLc = p.primaryKeyword.toLowerCase()
  const articleFormat: 'how_to' | 'listicle' | 'guide' | 'comparison' | 'news' =
    kwLc.startsWith('how to')                       ? 'how_to' :
    /^(best |top \d|\d+ )/.test(kwLc)               ? 'listicle' :
    /(\bvs\b|comparison|review)/.test(kwLc)         ? 'comparison' :
    /(news|update|patch|release)/.test(kwLc)        ? 'news' :
                                                       'guide'

  return `You are an expert content editor for G2G.com's blog / content marketing arm. Your job is to write a STANDALONE EDITORIAL ARTICLE — NOT a product category page. Think gaming media (PCGamer, Polygon-style) with a clear commercial through-line back to G2G's marketplace.

EDITORIAL MINDSET:
- This is for the BLOG, not a category page. No "trending products" placeholder, no price comparison tables as the lead.
- Long-form depth wins (1500-2500 words). Use storytelling, examples, original takes.
- Internal-link strategically to G2G product/category pages — but the value is the article itself.
- Detected format: **${articleFormat}** — structure the piece accordingly (see below).

CURRENT DATE: ${today}
${p.lang.instruction ? `\n${p.lang.instruction}\n` : ''}TARGET BLOG URL: ${p.page}
ARTICLE LANGUAGE: ${p.lang.name}
SERP COUNTRY: ${p.country.flag} ${p.country.label}
PRIMARY KEYWORD: ${p.primaryKeyword}
DETECTED FORMAT: ${articleFormat}

${p.gscQueries.length ? `GSC SIGNALS:
${p.gscQueries.map(q => `- "${q.query}" | clicks: ${q.clicks} | pos: ${q.position?.toFixed(1)}`).join('\n')}
` : ''}
TOP RANKING ARTICLES FOR "${p.primaryKeyword}":
${p.competitors.map((c, i) => `${i + 1}. ${c.title} — ${c.url}\n   ${c.description}`).join('\n')}

PEOPLE ALSO ASK (questions the article should answer):
${p.paa.map(q => `- ${q.question}`).join('\n')}

RELATED SEARCHES (long-tail to weave in):
${p.relatedSearches.map(r => `- ${r.query}`).join('\n')}

${p.selectedKeywords && p.selectedKeywords.filter(Boolean).length > 0 ? `
FOCUS KEYWORDS (hand-picked — prioritise above all others):
${p.selectedKeywords.filter(Boolean).map(k => `- ${k}`).join('\n')}
` : ''}KEYWORD SUGGESTIONS:
${p.kwSuggestions.map(k => `- "${k.keyword}" | vol: ${k.search_volume ?? '?'}`).join('\n')}

EDITOR NOTES: ${p.itemNotes || 'none'}

---
${buildKBBlock(p.kb, true)}
---

${p.customInstructions?.trim() ? `CUSTOM EDITOR INSTRUCTIONS:\n${p.customInstructions.trim()}\n\n` : ''}Write the brief with these EXACT sections:

## CURRENT CONTENT SUMMARY
Write exactly: "N/A — this is a new blog article."

## CONTENT GAPS
3-5 angles or data points the top-ranking competitor articles MISS or cover thinly. For each, suggest how our article will go deeper / be more useful / be more current.

## FRESHNESS OPPORTUNITIES
2-3 ways to make this article feel fresh as of ${today}:
- Recent game updates / patch notes / metas to reference
- Trending discussion threads worth citing
- Original data we can add (G2G marketplace pricing snapshots, etc.)

## RECOMMENDED KEYWORDS
5-8 keywords + LSI terms to use. Format: keyword | search intent | priority

## CONTENT OUTLINE
${articleFormat === 'how_to'     ? 'STEP-BY-STEP STRUCTURE: H1 + 5-8 numbered H2 steps. Each step: actionable, 100-200 words. End with a tools/recommended-products section linking to G2G category pages.'
: articleFormat === 'listicle'   ? 'LISTICLE STRUCTURE: H1 with the number ("Top N..."), intro, then N H2 entries. Each entry: brief description + why it ranks + 1-line "where to buy/get" linking to G2G.'
: articleFormat === 'comparison' ? 'COMPARISON STRUCTURE: H1 stating the comparison, intro, H2 "TL;DR / Winner", H2 sections per dimension (price/safety/delivery/etc.), final verdict.'
: articleFormat === 'news'       ? 'NEWS STRUCTURE: H1 with the news angle, lede (1 paragraph, who/what/when/why), H2 "What happened", H2 "Why it matters to gamers", H2 "What\'s next", H2 "Related on G2G".'
:                                  'GUIDE STRUCTURE: H1 stating the topic, intro (why this matters now), 5-7 H2 sections covering the topic depth-first, conclusion with next steps.'}

## FAQ SECTION
Write 4-6 Q&A pairs from the PAA list. These will become FAQ schema markup.

## CONTENT DRAFT
Write the FULL article draft (1500-2500 words). Use HTML with <h2>, <h3>, <p>, <ul>/<ol> — NOT markdown. Include 2-4 strategic internal links to G2G category/product pages where they add value (e.g. "buy [game] gold safely" → /categories/...). Conversational but authoritative tone.

Also output:
META TITLE: (≤60 chars — should match the article H1 closely, include primary keyword)
META DESCRIPTION: (≤110 chars — lead with the article's promise + a hook to click)`
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
  country: CountryPreset
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
SERP COUNTRY: ${p.country.flag} ${p.country.label}
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
