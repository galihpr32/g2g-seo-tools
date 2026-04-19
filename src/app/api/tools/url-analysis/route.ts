import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { smartScrape } from '@/lib/firecrawl/client'
import { batchSerpData, getKeywordSuggestions } from '@/lib/dataforseo/client'
import { getDomainOverview } from '@/lib/semrush/client'
import { getCountryPreset, SERP_COUNTRIES } from '@/lib/country-config'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { logApiUsage } from '@/lib/api-logger'

export const maxDuration = 60

export interface UrlAnalysisResponse {
  url: string
  is_own_page: boolean
  existing_action_item_id: string | null
  page_data: {
    title: string
    description: string
    h1: string[]
    h2: string[]
    wordCount: number
    contentPreview: string
  } | null
  primary_keyword: string
  serp: {
    organicResults: Array<{ rank: number; title: string; url: string; description: string }>
    peopleAlsoAsk: Array<{ question: string; answer?: string }>
    relatedSearches: string[]
  }
  keyword_suggestions: Array<{ keyword: string; search_volume: number | null; cpc: number | null }>
  domain_overview: {
    organicKeywords: number
    organicTraffic: number
    organicCost: number
  } | null
  country: { code: string; label: string; flag: string }
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    return u.hostname
  } catch {
    return url
  }
}

function extractPrimaryKeyword(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    const slug = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return slug.replace(/[-_]/g, ' ').trim() || 'website'
  } catch {
    return 'website'
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { url: inputUrl, country = 'id' } = body

    if (!inputUrl) {
      return NextResponse.json({ error: 'URL is required' }, { status: 400 })
    }

    const normalizedUrl = inputUrl.startsWith('http') ? inputUrl : `https://${inputUrl}`
    const domain = extractDomain(normalizedUrl)
    const primaryKeyword = extractPrimaryKeyword(normalizedUrl)
    const countryPreset = getCountryPreset(country)
    const isOwnPage = domain.includes('g2g.com')

    // Get effective owner ID for workspace queries
    const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)

    // Check for existing action item
    let existingActionItemId: string | null = null
    if (isOwnPage) {
      const { data: actionItem } = await supabase
        .from('seo_action_items')
        .select('id')
        .eq('user_id', effectiveOwnerId)
        .eq('page', normalizedUrl)
        .maybeSingle()

      existingActionItemId = actionItem?.id ?? null
    }

    // Fetch data in parallel with error handling
    const [
      pageData,
      serpData,
      keywordSuggestions,
      domainOverview,
    ] = await Promise.all([
      // Firecrawl: scrape page content
      (async () => {
        try {
          const scraped = await smartScrape(normalizedUrl)
          if (!scraped) return null

          const h1 = scraped.h1 ?? []
          const h2 = (scraped.h2 ?? []).slice(0, 10)
          const markdown = scraped.markdown ?? ''
          const contentPreview = markdown.slice(0, 3000)

          return {
            title: scraped.title ?? '',
            description: scraped.description ?? '',
            h1,
            h2,
            wordCount: scraped.wordCount ?? 0,
            contentPreview,
          }
        } catch (err) {
          console.error('Firecrawl error:', err)
          return null
        }
      })(),

      // DataForSEO: SERP data
      (async () => {
        try {
          const serp = await batchSerpData(
            [primaryKeyword],
            countryPreset.dfsLocationCode,
            countryPreset.dfsLanguageCode
          )

          return {
            organicResults: (serp.organicResults ?? [])
              .slice(0, 5)
              .map((r, idx) => ({
                rank: idx + 1,
                title: r.title,
                url: r.url,
                description: r.description,
              })),
            peopleAlsoAsk: (serp.peopleAlsoAsk ?? [])
              .slice(0, 5)
              .map(p => ({
                question: p.question,
                answer: p.answer,
              })),
            relatedSearches: (serp.relatedSearches ?? [])
              .slice(0, 5)
              .map(r => r.query),
          }
        } catch (err) {
          console.error('DataForSEO SERP error:', err)
          return {
            organicResults: [],
            peopleAlsoAsk: [],
            relatedSearches: [],
          }
        }
      })(),

      // DataForSEO: Keyword suggestions
      (async () => {
        try {
          const suggestions = await getKeywordSuggestions(
            primaryKeyword,
            countryPreset.dfsLocationCode,
            countryPreset.dfsLanguageCode,
            10
          )

          return (suggestions ?? []).map(s => ({
            keyword: s.keyword,
            search_volume: s.search_volume,
            cpc: s.cpc,
          }))
        } catch (err) {
          console.error('DataForSEO keyword suggestions error:', err)
          return []
        }
      })(),

      // SEMrush: Domain overview
      (async () => {
        try {
          const overview = await getDomainOverview(domain, countryPreset.semrushDb)
          if (!overview) return null

          return {
            organicKeywords: overview.organicKeywords,
            organicTraffic: overview.organicTraffic,
            organicCost: overview.organicCost,
          }
        } catch (err) {
          console.error('SEMrush domain overview error:', err)
          return null
        }
      })(),
    ])

    // Log API usage (fire-and-forget)
    logApiUsage(supabase, effectiveOwnerId, { api: 'firecrawl', endpoint: 'scrape', triggeredBy: 'url_analysis', metadata: { url: normalizedUrl } })
    logApiUsage(supabase, effectiveOwnerId, { api: 'dataforseo', endpoint: 'serp/google/organic', triggeredBy: 'url_analysis', metadata: { keyword: primaryKeyword } })
    logApiUsage(supabase, effectiveOwnerId, { api: 'dataforseo', endpoint: 'keywords_data/google/suggestions', triggeredBy: 'url_analysis', metadata: { keyword: primaryKeyword } })
    if (domainOverview) {
      logApiUsage(supabase, effectiveOwnerId, { api: 'semrush', endpoint: 'domain_overview', triggeredBy: 'url_analysis', metadata: { domain } })
    }

    const response: UrlAnalysisResponse = {
      url: normalizedUrl,
      is_own_page: isOwnPage,
      existing_action_item_id: existingActionItemId,
      page_data: pageData,
      primary_keyword: primaryKeyword,
      serp: serpData,
      keyword_suggestions: keywordSuggestions,
      domain_overview: domainOverview,
      country: {
        code: countryPreset.code,
        label: countryPreset.label,
        flag: countryPreset.flag,
      },
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('URL Analysis error:', err)
    return NextResponse.json(
      { error: 'Internal server error', detail: String(err) },
      { status: 500 }
    )
  }
}
