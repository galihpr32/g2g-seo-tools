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
// Returns search volume per keyword. Handles > 100 kws by chunking to keep
// under the DataForSEO API limit. Logs per-chunk hit rate to surface when
// the upstream returns no data (common for long-tail or niche game kws).
export async function getKeywordDifficulty(
  keywords: string[],
  locationCode = 2360,
  languageCode = 'id'
): Promise<Record<string, number>> {
  if (!keywords.length) return {}
  const CHUNK = 100  // DataForSEO Google Ads endpoint limit
  const result: Record<string, number> = {}

  let totalRequested = 0
  let totalReceived  = 0
  let totalWithSv    = 0

  for (let i = 0; i < keywords.length; i += CHUNK) {
    const batch = keywords.slice(i, i + CHUNK)
    totalRequested += batch.length

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await dfsPost<any>('/keywords_data/google_ads/search_volume/live', [
      {
        keywords:      batch,
        location_code: locationCode,
        language_code: languageCode,
      },
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = data?.tasks?.[0]?.result ?? []
    totalReceived += items.length
    for (const item of items) {
      if (item.keyword) {
        if (item.search_volume != null) {
          result[String(item.keyword).toLowerCase()] = item.search_volume
          totalWithSv++
        }
      }
    }
  }

  if (totalRequested > 0) {
    console.warn(
      `[dataforseo:getKeywordDifficulty] ${totalRequested} requested, ${totalReceived} returned, ${totalWithSv} with non-null SV `
      + `(location_code=${locationCode}, language_code=${languageCode})`,
    )
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

// ─── Bulk Keyword Difficulty ─────────────────────────────────────────────────
// Returns a map of keyword → difficulty score (0–100)
export async function getBulkKeywordDifficulty(
  keywords: string[],
  locationCode = 2840,
  languageCode  = 'en'
): Promise<Record<string, number>> {
  if (!keywords.length) return {}
  const data = await dfsPost<any>('/dataforseo_labs/google/bulk_keyword_difficulty/live', [{
    keywords:      keywords.slice(0, 1000),
    location_code: locationCode,
    language_code: languageCode,
  }])
  const result: Record<string, number> = {}
  for (const item of data?.tasks?.[0]?.result ?? []) {
    if (item.keyword != null) result[item.keyword] = item.keyword_difficulty ?? 0
  }
  return result
}

// ─── On-Page Audit ───────────────────────────────────────────────────────────
// Async crawl task: post → poll → summary

export interface OnPageAuditSummary {
  taskId: string
  crawlProgress: 'in_progress' | 'finished'
  pagesTotal: number
  pagesCrawled: number
  onpageScore: number
  // Issue counts
  noTitle: number
  noDescription: number
  noH1: number
  duplicateTitle: number
  duplicateDescription: number
  brokenLinks: number
  brokenResources: number
  is4xx: number
  is5xx: number
  largePageSize: number
  noImageAlt: number
  redirectChain: number
  isHttps: number
  linksInternal: number
  linksExternal: number
}

export async function startOnPageCrawl(target: string, maxCrawlPages = 100): Promise<string | null> {
  const data = await dfsPost<any>('/on_page/task_post', [
    {
      target,
      max_crawl_pages: maxCrawlPages,
      crawl_sub_domain: false,
      check_spell: false,
      enable_content_parsing: false,
      load_resources: true,
      enable_javascript: true,   // needed for JS-rendered sites like g2g.com
      custom_js: '',
    },
  ])
  return data?.tasks?.[0]?.id ?? null
}

export async function getOnPageSummary(taskId: string): Promise<OnPageAuditSummary | null> {
  const data = await dfsPost<any>(`/on_page/summary`, [{ id: taskId }])
  const result = data?.tasks?.[0]?.result?.[0]
  if (!result) return null

  const m = result.page_metrics ?? {}
  const cs = result.crawl_status ?? {}

  return {
    taskId,
    crawlProgress:       result.crawl_progress === 'finished' ? 'finished' : 'in_progress',
    pagesTotal:          cs.max_crawl_pages ?? 0,
    pagesCrawled:        cs.pages_crawled ?? 0,
    onpageScore:         result.onpage_score ?? 0,
    noTitle:             m.no_title ?? m.checks?.no_title ?? 0,
    noDescription:       m.no_description ?? m.checks?.no_description ?? 0,
    noH1:                m.no_h1_tag ?? m.checks?.no_h1_tag ?? 0,
    duplicateTitle:      m.duplicate_title ?? m.checks?.duplicate_title ?? 0,
    duplicateDescription: m.duplicate_description ?? m.checks?.duplicate_description ?? 0,
    brokenLinks:         m.broken_links ?? m.checks?.broken_links ?? 0,
    brokenResources:     m.broken_resources ?? m.checks?.broken_resources ?? 0,
    is4xx:               m.is_4xx_code ?? m.checks?.is_4xx_code ?? 0,
    is5xx:               m.is_5xx_code ?? m.checks?.is_5xx_code ?? 0,
    largePageSize:       m.large_page_size ?? m.checks?.large_page_size ?? 0,
    noImageAlt:          m.no_image_alt ?? m.checks?.no_image_alt ?? 0,
    redirectChain:       m.redirect_chain ?? m.checks?.redirect_chain ?? 0,
    isHttps:             m.checks?.is_https ?? 0,
    linksInternal:       m.links_internal ?? 0,
    linksExternal:       m.links_external ?? 0,
  }
}

// ─── On-Page: Pages List ─────────────────────────────────────────────────────
// Returns all crawled pages with their inbound/outbound internal link counts
export interface OnPagePageItem {
  url: string
  inlinks_count: number          // how many internal pages link TO this page
  links_internal: number         // how many internal links go OUT from this page
  links_external: number
  onpage_score: number | null
  resource_type: string
  status_code: number | null
  meta?: { title?: string; canonical?: string }
}

export async function getOnPagePages(
  taskId: string,
  limit = 1000
): Promise<OnPagePageItem[]> {
  const data = await dfsPost<any>('/on_page/pages', [{
    id: taskId,
    limit,
    filters: [['resource_type', '=', 'html']],
    order_by: ['meta.inlinks_count,desc'],
  }])
  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  return items.map(i => ({
    url:            i.url ?? '',
    inlinks_count:  i.meta?.inlinks_count ?? 0,
    links_internal: i.meta?.internal_links_count ?? 0,
    links_external: i.meta?.external_links_count ?? 0,
    onpage_score:   i.onpage_score ?? null,
    resource_type:  i.resource_type ?? 'html',
    status_code:    i.status_code ?? null,
    meta: { title: i.meta?.title ?? '', canonical: i.meta?.canonical ?? '' },
  }))
}

// ─── On-Page: Internal Links ──────────────────────────────────────────────────
// Returns all discovered internal links (link_from → link_to) from a crawl
export interface OnPageLinkItem {
  link_from: string
  link_to:   string
  anchor:    string | null
  dofollow:  boolean
}

export async function getOnPageLinks(
  taskId: string,
  limit = 5000
): Promise<OnPageLinkItem[]> {
  const data = await dfsPost<any>('/on_page/links', [{
    id: taskId,
    limit,
    filters: [['link_type', '=', 'anchor'], ['internal', '=', true]],
  }])
  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  return items.map(i => ({
    link_from: i.link_from ?? '',
    link_to:   i.link_to   ?? '',
    anchor:    i.anchor    ?? null,
    dofollow:  !(i.link_attribute ?? []).includes('nofollow'),
  }))
}

// ─── On-Page: Pages with a specific issue ────────────────────────────────────
// Returns pages that fail a specific on-page check (e.g. "no_h1_tag")
// DFS check keys: no_title, no_description, no_h1_tag, duplicate_title,
//   duplicate_description, no_image_alt, redirect_chain, large_page_size,
//   is_https, broken_links, broken_resources
export interface OnPageIssuePageItem {
  url: string
  status_code: number | null
  onpage_score: number | null
  title: string | null
}

export async function getOnPagePagesWithCheck(
  taskId: string,
  checkKey: string,  // e.g. "no_h1_tag"
  limit = 100
): Promise<OnPageIssuePageItem[]> {
  const data = await dfsPost<any>('/on_page/pages', [{
    id: taskId,
    limit,
    filters: [
      ['resource_type', '=', 'html'],
      'and',
      [`checks.${checkKey}`, '=', true],
    ],
    order_by: ['onpage_score,asc'],
  }])
  const items: any[] = data?.tasks?.[0]?.result?.[0]?.items ?? []
  return items.map(i => ({
    url:          i.url ?? '',
    status_code:  i.status_code ?? null,
    onpage_score: i.onpage_score ?? null,
    title:        i.meta?.title ?? null,
  }))
}

// Poll until finished (max ~45s)
export async function pollOnPageTask(taskId: string, maxWaitMs = 45_000): Promise<OnPageAuditSummary | null> {
  const interval = 5_000
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    const summary = await getOnPageSummary(taskId)
    if (!summary) return null
    if (summary.crawlProgress === 'finished') return summary
    await new Promise(r => setTimeout(r, interval))
  }
  // Return whatever we have (still in-progress)
  return await getOnPageSummary(taskId)
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
