// ─── DataForSEO API Client ────────────────────────────────────────────────────
// Docs: https://docs.dataforseo.com/
// Env:  DATAFORSEO_LOGIN   (your account email / login)
//       DATAFORSEO_PASSWORD (your API password from dashboard)
//
// Covers:
//   - SERP organic results (competitor landscape for a keyword)
//   - People Also Ask (PAA) → FAQ source
//   - Related searches → long-tail keyword ideas
//   - Keyword suggestions (volume, CPC, competition)
//   - Domain keyword overview (what keywords a page ranks for)

const BASE = 'https://api.dataforseo.com/v3'

function authHeader() {
  const login = process.env.DATAFORSEO_LOGIN ?? ''
  const pass  = process.env.DATAFORSEO_PASSWORD ?? ''
  return 'Basic ' + Buffer.from(`${login}:${pass}`).toString('base64')
}

async function dfsPost<T = unknown>(path: string, body: unknown): Promise<T | null> {
  if (!process.env.DATAFORSEO_LOGIN || !process.env.DATAFORSEO_PASSWORD) {
    console.warn('DataForSEO credentials not set')
    return null
  }
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.error('DataForSEO error:', res.status, await res.text())
      return null
    }
    return await res.json() as T
  } catch (err) {
    console.error('DataForSEO fetch error:', err)
    return null
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SerpOrganicResult {
  rank_absolute: number
  url: string
  title: string
  description: string
  domain: string
}

export interface PeopleAlsoAsk {
  question: string
  answer?: string
  url?: string
}

export interface RelatedSearch {
  query: string
}

export interface KeywordSuggestion {
  keyword: string
  search_volume: number | null
  cpc: number | null
  competition: number | null
  keyword_difficulty: number | null
}

export interface SerpPageData {
  organicResults: SerpOrganicResult[]
  peopleAlsoAsk: PeopleAlsoAsk[]
  relatedSearches: RelatedSearch[]
}

// ─── SERP Analysis: organic results + PAA + related searches ─────────────────
// Used for both on-page (understand competitive landscape) and off-page (find content gaps)
export async function getSerpData(
  keyword: string,
  locationCode = 2360,  // Indonesia
  languageCode = 'id',
  depth = 10
): Promise<SerpPageData> {
  const data = await dfsPost<any>('/serp/google/organic/live/advanced', [
    {
      keyword,
      location_code: locationCode,
      language_code: languageCode,
      depth,
      calculate_rectangles: false,
    },
  ])

  const result: SerpPageData = { organicResults: [], peopleAlsoAsk: [], relatedSearches: [] }
  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []

  for (const item of items) {
    if (item.type === 'organic') {
      result.organicResults.push({
        rank_absolute: item.rank_absolute,
        url: item.url,
        title: item.title,
        description: item.description ?? '',
        domain: item.domain,
      })
    } else if (item.type === 'people_also_ask') {
      for (const paa of item.items ?? []) {
        result.peopleAlsoAsk.push({
          question: paa.title,
          answer: paa.expanded_element?.[0]?.description ?? undefined,
          url: paa.expanded_element?.[0]?.url ?? undefined,
        })
      }
    } else if (item.type === 'related_searches') {
      for (const rel of item.items ?? []) {
        result.relatedSearches.push({ query: rel.title })
      }
    }
  }

  return result
}

// ─── Keyword Suggestions / Ideas ─────────────────────────────────────────────
// Given a seed keyword, returns related keyword ideas with volume + difficulty
export async function getKeywordSuggestions(
  keyword: string,
  locationCode = 2360,
  languageCode = 'id',
  limit = 30
): Promise<KeywordSuggestion[]> {
  const data = await dfsPost<any>('/keywords_data/google_ads/keywords_for_keywords/live', [
    {
      keywords: [keyword],
      location_code: locationCode,
      language_code: languageCode,
    },
  ])

  const items: any[] = data?.tasks?.[0]?.result ?? []
  return items
    .filter(i => i.search_volume > 0)
    .sort((a, b) => (b.search_volume ?? 0) - (a.search_volume ?? 0))
    .slice(0, limit)
    .map(i => ({
      keyword: i.keyword,
      search_volume: i.search_volume ?? null,
      cpc: i.cpc ?? null,
      competition: i.competition ?? null,
      keyword_difficulty: i.keyword_difficulty ?? null,
    }))
}

// ─── Keyword Difficulty (bulk check) ─────────────────────────────────────────
export async function getKeywordDifficulty(
  keywords: string[],
  locationCode = 2360,
  languageCode = 'id'
): Promise<Record<string, number>> {
  if (!keywords.length) return {}
  const data = await dfsPost<any>('/keywords_data/google_ads/search_volume/live', [
    {
      keywords: keywords.slice(0, 100), // API limit
      location_code: locationCode,
      language_code: languageCode,
    },
  ])

  const result: Record<string, number> = {}
  for (const item of data?.tasks?.[0]?.result ?? []) {
    if (item.keyword && item.search_volume != null) {
      result[item.keyword] = item.search_volume
    }
  }
  return result
}

// ─── Domain Ranked Keywords (what does this URL rank for?) ───────────────────
// Useful to understand current keyword coverage of a page
export async function getDomainRankedKeywords(
  domain: string,
  locationCode = 2360,
  languageCode = 'id',
  limit = 50
): Promise<{ keyword: string; position: number; url: string; volume: number | null }[]> {
  const data = await dfsPost<any>('/dataforseo_labs/google/ranked_keywords/live', [
    {
      target: domain,
      location_code: locationCode,
      language_code: languageCode,
      limit,
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
    },
  ])

  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  return items.map(i => ({
    keyword: i.keyword_data?.keyword,
    position: i.ranked_serp_element?.serp_item?.rank_absolute,
    url: i.ranked_serp_element?.serp_item?.url,
    volume: i.keyword_data?.keyword_info?.search_volume ?? null,
  })).filter(i => i.keyword)
}

// ─── Google Trends ────────────────────────────────────────────────────────────
// Returns relative interest (0-100) over the past 30 days for each keyword.
export interface TrendPoint { date: string; values: Record<string, number> }

export async function getGoogleTrends(
  keywords: string[],
  locationCode = 2840,  // United States
  languageCode  = 'en',
  timeRange     = 'past_30_days'
): Promise<TrendPoint[]> {
  if (!keywords.length) return []
  const data = await dfsPost<any>('/keywords_data/google_trends/explore/live', [
    {
      keywords: keywords.slice(0, 5),  // max 5 per request
      time_range: timeRange,
      type: 'web_search',
      category_code: 0,
      location_code: locationCode,
      language_code: languageCode,
    },
  ])

  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  const timelineItem = items.find((i: any) => i.type === 'google_trends_graph')
  if (!timelineItem?.data) return []

  // data is an array of {date_from, date_to, values: [{keyword, value}]}
  return (timelineItem.data as any[]).map(point => {
    const values: Record<string, number> = {}
    for (const v of point.values ?? []) values[v.keyword] = v.value ?? 0
    return { date: point.date_from?.split('T')[0] ?? '', values }
  })
}

// ─── Competitor Domains (who competes with this domain organically?) ─────────
export interface CompetitorDomainDFS {
  domain: string
  organicKeywords: number
  organicTraffic: number
  organicCost: number
}

export async function getCompetitorDomainsDFS(
  domain: string,
  locationCode = 2840,   // United States
  languageCode = 'en',
  limit = 15
): Promise<CompetitorDomainDFS[]> {
  const data = await dfsPost<any>('/dataforseo_labs/google/competitors_domain/live', [
    {
      target: domain,
      location_code: locationCode,
      language_code: languageCode,
      limit,
      filters: ['full_domain_metrics.organic.etv', '>', 0],
      order_by: ['full_domain_metrics.organic.estimated_visits,desc'],
    },
  ])

  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  return items.map(i => ({
    domain: i.domain ?? '',
    organicKeywords: i.full_domain_metrics?.organic?.count ?? 0,
    organicTraffic: i.full_domain_metrics?.organic?.estimated_visits ?? 0,
    organicCost: Math.round(i.full_domain_metrics?.organic?.etv ?? 0),
  })).filter(i => i.domain)
}

// ─── Domain Metrics Overview ─────────────────────────────────────────────────
export interface DomainOverviewDFS {
  organicKeywords: number
  organicTraffic: number
  organicCost: number
}

export async function getDomainOverviewDFS(
  domain: string,
  locationCode = 2840,
  languageCode = 'en'
): Promise<DomainOverviewDFS | null> {
  const data = await dfsPost<any>('/dataforseo_labs/google/domain_metrics/live', [
    {
      target: domain,
      location_code: locationCode,
      language_code: languageCode,
    },
  ])

  const organic = data?.tasks?.[0]?.result?.[0]?.metrics?.organic
  if (!organic) return null
  return {
    organicKeywords: organic.count ?? 0,
    organicTraffic: organic.estimated_visits ?? 0,
    organicCost: Math.round(organic.etv ?? 0),
  }
}

// ─── SERP for multiple keywords (batch) ─────────────────────────────────────
// Run SERP for top 3 GSC queries of the page to get comprehensive PAA + related
export async function batchSerpData(
  keywords: string[],
  locationCode = 2360,
  languageCode = 'id'
): Promise<SerpPageData> {
  const merged: SerpPageData = { organicResults: [], peopleAlsoAsk: [], relatedSearches: [] }
  const seenQuestions = new Set<string>()
  const seenRelated = new Set<string>()

  await Promise.all(
    keywords.slice(0, 3).map(async kw => {
      const d = await getSerpData(kw, locationCode, languageCode, 10)
      if (!merged.organicResults.length) merged.organicResults = d.organicResults
      for (const p of d.peopleAlsoAsk) {
        if (!seenQuestions.has(p.question)) {
          seenQuestions.add(p.question)
          merged.peopleAlsoAsk.push(p)
        }
      }
      for (const r of d.relatedSearches) {
        if (!seenRelated.has(r.query)) {
          seenRelated.add(r.query)
          merged.relatedSearches.push(r)
        }
      }
    })
  )
  return merged
}
