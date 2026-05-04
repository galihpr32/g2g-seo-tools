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
  params:    Record<string, string>,
  opts?:     BingApiOptions,
): Promise<{ data: T | null; debug: BingDebug }> {
  const debug: BingDebug = { endpoint, status: 0, ok: false, message: '' }
  const auth = resolveAuth(opts)
  if (!auth) {
    debug.message = 'BING_WEBMASTER_API_KEY or BING_SITE_URL not configured'
    console.warn(`[bing] ${debug.message}`)
    return { data: null, debug }
  }

  // Bing JSON API uses GET with all params in the query string, not POST + body.
  const url = new URL(`${API_BASE}/${endpoint}`)
  url.searchParams.set('apikey',  auth.apiKey)
  url.searchParams.set('siteUrl', auth.siteUrl)
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v)
  }
  debug.url = `${API_BASE}/${endpoint}?siteUrl=${encodeURIComponent(auth.siteUrl)}&apikey=***`

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(20_000),
    })

    debug.status = res.status
    debug.ok     = res.ok

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      debug.message = `HTTP ${res.status}: ${text.slice(0, 300)}`
      console.error(`[bing] ${endpoint}`, debug.message)
      return { data: null, debug }
    }

    const json = await res.json() as { d?: T; ErrorCode?: number; Message?: string }

    // Bing sometimes returns 200 with an in-body error envelope
    if ('ErrorCode' in json && json.ErrorCode) {
      debug.message = `Bing ErrorCode ${json.ErrorCode}: ${json.Message ?? ''}`
      console.error(`[bing] ${endpoint}`, debug.message)
      return { data: null, debug }
    }

    debug.message = 'OK'
    return { data: json?.d ?? null, debug }
  } catch (err) {
    debug.message = `network error: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[bing] ${endpoint}`, debug.message)
    return { data: null, debug }
  }
}

export interface BingDebug {
  endpoint: string
  url?:     string
  status:   number
  ok:       boolean
  message:  string
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

export async function getQueryStats(opts?: BingApiOptions): Promise<{ data: BingQueryStat[]; debug: BingDebug }> {
  const { data, debug } = await callBingApi<BingQueryStat[]>('GetQueryStats', {}, opts)
  return { data: data ?? [], debug }
}

// ─── Page-level stats ────────────────────────────────────────────────────────
export interface BingPageStat {
  Page:                  string
  Clicks:                number
  Impressions:           number
  AvgClickPosition:      number
  AvgImpressionPosition: number
}

export async function getPageStats(opts?: BingApiOptions): Promise<{ data: BingPageStat[]; debug: BingDebug }> {
  const { data, debug } = await callBingApi<BingPageStat[]>('GetPageStats', {}, opts)
  return { data: data ?? [], debug }
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
): Promise<{ data: BingPageQueryStat[]; debug: BingDebug }> {
  const { data, debug } = await callBingApi<BingPageQueryStat[]>('GetPageQueryStats', { page }, opts)
  return { data: data ?? [], debug }
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
): Promise<{ data: BingUrlInfo | null; debug: BingDebug }> {
  return await callBingApi<BingUrlInfo>('GetUrlInfo', { url }, opts)
}

// ─── Rank & Traffic — overall site stats (last N days) ───────────────────────
export interface BingRankAndTrafficStat {
  Date:        string  // /Date(unix-millis)/
  Clicks:      number
  Impressions: number
}

export async function getRankAndTrafficStats(opts?: BingApiOptions): Promise<{ data: BingRankAndTrafficStat[]; debug: BingDebug }> {
  const { data, debug } = await callBingApi<BingRankAndTrafficStat[]>('GetRankAndTrafficStats', {}, opts)
  return { data: data ?? [], debug }
}

// ─── Health check ────────────────────────────────────────────────────────────
export async function checkConnection(opts?: BingApiOptions): Promise<{
  configured: boolean
  reachable:  boolean
  message:    string
  debug?:     BingDebug
}> {
  const auth = resolveAuth(opts)
  if (!auth) return { configured: false, reachable: false, message: 'BING_WEBMASTER_API_KEY or BING_SITE_URL not set' }

  // GetRankAndTrafficStats is the cheapest call to verify auth + connectivity
  const { data, debug } = await getRankAndTrafficStats(opts)
  if (!debug.ok) {
    return { configured: true, reachable: false, message: debug.message, debug }
  }
  if (data.length === 0) {
    return { configured: true, reachable: false, message: 'API responded but no data — check site verification', debug }
  }
  return { configured: true, reachable: true, message: `Connected · ${data.length} data points returned`, debug }
}

// ─── Bing date format helper ─────────────────────────────────────────────────
// Bing returns dates as "/Date(1715126400000)/" — JSON serializer thing.
export function parseBingDate(bingDate: string): Date | null {
  const m = bingDate?.match(/\/Date\((\d+)\)\//)
  if (!m) return null
  return new Date(Number(m[1]))
}
