// ─── Bing Webmaster API Client ────────────────────────────────────────────────
// Docs: https://learn.microsoft.com/en-us/bingwebmaster/getting-access
//
// Auth: API key (single string) — simpler than OAuth.
// Get key at https://www.bing.com/webmasters → Settings → API access.
//
// Env required:
//   BING_WEBMASTER_API_KEY   — your API key
//   BING_SITE_URL            — verified site URL (e.g. "https://g2g.com")

const API_BASE = 'https://ssl.bing.com/webmaster/api.svc/json'

interface BingApiOptions {
  apiKey?:   string
  siteUrl?:  string
}

function resolveAuth(opts?: BingApiOptions): { apiKey: string; siteUrl: string } | null {
  const apiKey  = opts?.apiKey  ?? process.env.BING_WEBMASTER_API_KEY
  const siteUrl = opts?.siteUrl ?? process.env.BING_SITE_URL
  if (!apiKey || !siteUrl) return null
  return { apiKey, siteUrl }
}

async function callBingApi<T = unknown>(
  endpoint:  string,
  body:      Record<string, unknown>,
  opts?:     BingApiOptions,
): Promise<T | null> {
  const auth = resolveAuth(opts)
  if (!auth) {
    console.warn('[bing] BING_WEBMASTER_API_KEY or BING_SITE_URL not configured')
    return null
  }

  const url = `${API_BASE}/${endpoint}?apikey=${encodeURIComponent(auth.apiKey)}`
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ siteUrl: auth.siteUrl, ...body }),
      signal:  AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[bing] ${endpoint} HTTP ${res.status}:`, text.slice(0, 300))
      return null
    }

    const data = await res.json() as { d?: T }
    return data?.d ?? null
  } catch (err) {
    console.error(`[bing] ${endpoint} error:`, err)
    return null
  }
}

// ─── Search Performance ───────────────────────────────────────────────────────
// Returns query-level performance for the last N days.
// Bing's GetQueryStats / GetSearchPerformance returns aggregated metrics.

export interface BingQueryStat {
  Query:                    string
  Clicks:                   number
  Impressions:              number
  AvgClickPosition:         number
  AvgImpressionPosition:    number
}

export async function getQueryStats(opts?: BingApiOptions): Promise<BingQueryStat[]> {
  const data = await callBingApi<BingQueryStat[]>('GetQueryStats', {}, opts)
  return data ?? []
}

// ─── Page-level stats ────────────────────────────────────────────────────────
export interface BingPageStat {
  Page:                  string
  Clicks:                number
  Impressions:           number
  AvgClickPosition:      number
  AvgImpressionPosition: number
}

export async function getPageStats(opts?: BingApiOptions): Promise<BingPageStat[]> {
  const data = await callBingApi<BingPageStat[]>('GetPageStats', {}, opts)
  return data ?? []
}

// ─── Per-page query breakdown ────────────────────────────────────────────────
export interface BingPageQueryStat {
  Query:                 string
  Clicks:                number
  Impressions:           number
  AvgClickPosition:      number
  AvgImpressionPosition: number
}

export async function getPageQueryStats(
  page:  string,
  opts?: BingApiOptions,
): Promise<BingPageQueryStat[]> {
  const data = await callBingApi<BingPageQueryStat[]>('GetPageQueryStats', { page }, opts)
  return data ?? []
}

// ─── URL info: index status + crawl health ───────────────────────────────────
export interface BingUrlInfo {
  Url:               string
  TotalClicks:       number
  TotalImpressions:  number
  HttpCode:          number
  IsIndexed:         boolean
  LastCrawledDate?:  string  // ISO date
  CrawlErrors?:      string
}

export async function getUrlInfo(
  url:   string,
  opts?: BingApiOptions,
): Promise<BingUrlInfo | null> {
  return await callBingApi<BingUrlInfo>('GetUrlInfo', { url }, opts)
}

// ─── Rank & Traffic — overall site stats (last N days) ───────────────────────
export interface BingRankAndTrafficStat {
  Date:        string  // /Date(unix-millis)/
  Clicks:      number
  Impressions: number
}

export async function getRankAndTrafficStats(opts?: BingApiOptions): Promise<BingRankAndTrafficStat[]> {
  const data = await callBingApi<BingRankAndTrafficStat[]>('GetRankAndTrafficStats', {}, opts)
  return data ?? []
}

// ─── Health check ────────────────────────────────────────────────────────────
export async function checkConnection(opts?: BingApiOptions): Promise<{
  configured: boolean
  reachable:  boolean
  message:    string
}> {
  const auth = resolveAuth(opts)
  if (!auth) return { configured: false, reachable: false, message: 'BING_WEBMASTER_API_KEY or BING_SITE_URL not set' }

  // GetRankAndTrafficStats is the cheapest call to verify auth + connectivity
  const data = await getRankAndTrafficStats(opts)
  if (data.length === 0) {
    return { configured: true, reachable: false, message: 'API responded but no data — check site verification' }
  }
  return { configured: true, reachable: true, message: `Connected · ${data.length} data points returned` }
}

// ─── Bing date format helper ─────────────────────────────────────────────────
// Bing returns dates as "/Date(1715126400000)/" — JSON serializer thing.
export function parseBingDate(bingDate: string): Date | null {
  const m = bingDate?.match(/\/Date\((\d+)\)\//)
  if (!m) return null
  return new Date(Number(m[1]))
}
