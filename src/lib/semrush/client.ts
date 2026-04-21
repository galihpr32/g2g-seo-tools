// SEMrush API client
// Docs: https://developer.semrush.com/api/v2/analytics/

const BASE_URL = 'https://api.semrush.com'
const API_KEY = process.env.SEMRUSH_API_KEY ?? ''

export interface KeywordRanking {
  keyword: string
  position: number
  previousPosition: number
  positionDiff: number
  searchVolume: number
  cpc: number
  url: string
  trafficPercent: number
}

export interface SiteAuditSummary {
  errors: number
  warnings: number
  notices: number
  healthScore: number
}

export interface CompetitorDomain {
  domain: string
  organicKeywords: number
  organicTraffic: number
  organicCost: number
}

// ─── Organic keyword rankings for a domain ───────────────────────────────────
export async function getDomainKeywords(
  domain: string,
  database = 'us',
  limit = 100
): Promise<KeywordRanking[]> {
  const params = new URLSearchParams({
    type: 'domain_organic',
    key: API_KEY,
    domain,
    database,
    display_limit: String(limit),
    display_sort: 'tr_desc',
    export_columns: 'Ph,Po,Pp,Pd,Nq,Cp,Ur,Tr',
    export_escape: '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) throw new Error(`SEMrush API error: ${res.status}`)

  const text = await res.text()
  if (text.startsWith('ERROR')) throw new Error(`SEMrush: ${text}`)

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  // Skip header row
  return lines.slice(1).map(line => {
    const [keyword, position, prevPosition, posDiff, searchVolume, cpc, url, trafficPercent] = line.split(';').map(s => s.replace(/"/g, ''))
    return {
      keyword: keyword ?? '',
      position: parseInt(position) || 0,
      previousPosition: parseInt(prevPosition) || 0,
      positionDiff: parseInt(posDiff) || 0,
      searchVolume: parseInt(searchVolume) || 0,
      cpc: parseFloat(cpc) || 0,
      url: url ?? '',
      trafficPercent: parseFloat(trafficPercent) || 0,
    }
  }).filter(r => r.keyword)
}

// ─── Domain overview (backlinks, traffic estimate) ───────────────────────────
export async function getDomainOverview(domain: string, database = 'us') {
  const params = new URLSearchParams({
    type: 'domain_ranks',
    key: API_KEY,
    domain,
    database,
    export_columns: 'Dn,Rk,Or,Ot,Oc,Ad,At,Ac',
    export_escape: '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) throw new Error(`SEMrush API error: ${res.status}`)

  const text = await res.text()
  if (text.startsWith('ERROR')) throw new Error(`SEMrush: ${text}`)

  const lines = text.trim().split('\n')
  if (lines.length < 2) return null

  const [domain_, rank, organicKeywords, organicTraffic, organicCost, adKeywords, adTraffic, adCost] =
    lines[1].split(';').map(s => s.replace(/"/g, ''))

  return {
    domain: domain_,
    rank: parseInt(rank) || 0,
    organicKeywords: parseInt(organicKeywords) || 0,
    organicTraffic: parseInt(organicTraffic) || 0,
    organicCost: parseFloat(organicCost) || 0,
    adKeywords: parseInt(adKeywords) || 0,
    adTraffic: parseInt(adTraffic) || 0,
    adCost: parseFloat(adCost) || 0,
  }
}

// ─── Competitor domains ───────────────────────────────────────────────────────
export async function getCompetitors(domain: string, database = 'us', limit = 10): Promise<CompetitorDomain[]> {
  const params = new URLSearchParams({
    type: 'domain_organic_organic',
    key: API_KEY,
    domain,
    database,
    display_limit: String(limit),
    export_columns: 'Dn,Or,Ot,Oc',
    export_escape: '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) throw new Error(`SEMrush API error: ${res.status}`)

  const text = await res.text()
  if (text.startsWith('ERROR')) throw new Error(`SEMrush: ${text}`)

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  return lines.slice(1).map(line => {
    const [competitorDomain, organicKeywords, organicTraffic, organicCost] = line.split(';').map(s => s.replace(/"/g, ''))
    return {
      domain: competitorDomain ?? '',
      organicKeywords: parseInt(organicKeywords) || 0,
      organicTraffic: parseInt(organicTraffic) || 0,
      organicCost: parseFloat(organicCost) || 0,
    }
  }).filter(r => r.domain)
}

// ─── Batch keyword volume lookup ─────────────────────────────────────────────
// Calls phrase_these to get search volume for up to 100 keywords at once.
// Returns a map: keyword (lowercase) → { search_volume, cpc, keyword_difficulty }
export async function getKeywordVolumes(
  keywords: string[],
  database = 'us'
): Promise<Map<string, { search_volume: number; cpc: number; keyword_difficulty: number }>> {
  const result = new Map<string, { search_volume: number; cpc: number; keyword_difficulty: number }>()

  if (!API_KEY || API_KEY === 'placeholder' || keywords.length === 0) return result

  // SEMrush phrase_these accepts up to 100 keywords, separated by semicolons
  const BATCH = 100
  for (let i = 0; i < keywords.length; i += BATCH) {
    const batch = keywords.slice(i, i + BATCH)
    const phrase = batch.map(k => encodeURIComponent(k)).join(';')

    try {
      const params = new URLSearchParams({
        type:            'phrase_these',
        key:             API_KEY,
        phrase,
        database,
        export_columns:  'Ph,Nq,Cp,Kd',
        export_escape:   '1',
      })

      const res = await fetch(`${BASE_URL}/analytics/v1/?${params}`, {
        signal: AbortSignal.timeout(15000),
      })

      if (!res.ok) continue
      const text = await res.text()
      if (!text || text.startsWith('ERROR')) continue

      const lines = text.trim().split('\n').slice(1) // skip header
      for (const line of lines) {
        const [kw, nq, cp, kd] = line.split(';').map(s => s.replace(/"/g, '').trim())
        if (kw) {
          result.set(kw.toLowerCase(), {
            search_volume:      parseInt(nq) || 0,
            cpc:                parseFloat(cp) || 0,
            keyword_difficulty: parseInt(kd) || 0,
          })
        }
      }
    } catch { /* batch failed — skip */ }
  }

  return result
}

// ─── SERP feature codes ───────────────────────────────────────────────────────
export const SERP_FEATURE_LABELS: Record<number, string> = {
  1:  'Instant Answer',
  2:  'Knowledge Panel',
  3:  'Carousel',
  4:  'Local Pack',
  5:  'Image Pack',
  7:  'Featured Snippet',
  8:  'Shopping Results',
  10: 'Reviews',
  11: 'Sitelinks',
  12: 'Video',
  13: 'Twitter / X',
  14: 'News',
  15: 'People Also Ask',
  16: 'App Pack',
  17: 'AMP',
  22: 'Featured Video',
}

export const SERP_FEATURE_ICONS: Record<number, string> = {
  1:  '💡',
  2:  '🧠',
  3:  '🎠',
  4:  '📍',
  5:  '🖼️',
  7:  '⭐',
  8:  '🛒',
  10: '⭐',
  11: '🔗',
  12: '▶️',
  13: '🐦',
  14: '📰',
  15: '❓',
  16: '📱',
  17: '⚡',
  22: '🎬',
}

export interface SerpFeatureRow {
  keyword:      string
  position:     number
  searchVolume: number
  url:          string
  captured:     number[]   // feature codes where G2G appears
  available:    number[]   // all feature codes present on SERP
}

// Fetch organic keywords with SERP feature columns (Fp = G2G captures, Fk = all on SERP)
export async function getDomainKeywordsWithFeatures(
  domain:   string,
  database = 'us',
  limit    = 1000
): Promise<SerpFeatureRow[]> {
  const params = new URLSearchParams({
    type:            'domain_organic',
    key:             API_KEY,
    domain,
    database,
    display_limit:   String(limit),
    display_sort:    'nq_desc',
    export_columns:  'Ph,Po,Nq,Ur,Fp,Fk',
    export_escape:   '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) throw new Error(`SEMrush API error: ${res.status}`)
  const text = await res.text()
  if (text.startsWith('ERROR')) throw new Error(`SEMrush: ${text}`)

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  function parseCodes(raw: string): number[] {
    if (!raw || raw === '0') return []
    return raw.split('|').map(Number).filter(n => !isNaN(n) && n > 0)
  }

  return lines.slice(1).map(line => {
    const parts = line.split(';').map(s => s.replace(/"/g, '').trim())
    return {
      keyword:      parts[0] ?? '',
      position:     parseInt(parts[1])  || 0,
      searchVolume: parseInt(parts[2])  || 0,
      url:          parts[3] ?? '',
      captured:     parseCodes(parts[4]),
      available:    parseCodes(parts[5]),
    }
  }).filter(r => r.keyword)
}

// ─── Backlinks ────────────────────────────────────────────────────────────────
export interface BacklinkOverview {
  total:           number
  domains:         number
  ips:             number
  subnets:         number
  followLinks:     number
  nofollowLinks:   number
  authorityScore:  number
}

export interface BacklinkRow {
  sourceUrl:      string
  sourceDomain:   string
  targetUrl:      string
  anchorText:     string
  type:           string   // 'text' | 'image' | 'form' | 'frame'
  dofollow:       boolean
  authorityScore: number
  externalLinks:  number
  firstSeen:      string
  lastSeen:       string
}

export interface ReferringDomainRow {
  domain:         string
  authorityScore: number
  backlinks:      number
  follows:        number
  noFollows:      number
  firstSeen:      string
  lastSeen:       string
}

export async function getBacklinkOverview(target: string): Promise<BacklinkOverview | null> {
  const params = new URLSearchParams({
    type:           'backlinks_overview',
    key:            API_KEY,
    target,
    target_type:    'root_domain',
    export_columns: 'total,domains_num,ips_num,subnets_num,follows_num,nofollows_num,ascore',
    export_escape:  '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) return null
  const text = await res.text()
  if (!text || text.startsWith('ERROR')) return null

  const lines = text.trim().split('\n')
  if (lines.length < 2) return null

  const [total, domains, ips, subnets, follows, noFollows, ascore] = lines[1].split(';').map(s => s.replace(/"/g, ''))
  return {
    total:          parseInt(total)    || 0,
    domains:        parseInt(domains)  || 0,
    ips:            parseInt(ips)      || 0,
    subnets:        parseInt(subnets)  || 0,
    followLinks:    parseInt(follows)  || 0,
    nofollowLinks:  parseInt(noFollows)|| 0,
    authorityScore: parseInt(ascore)   || 0,
  }
}

export async function getReferringDomains(target: string, limit = 100): Promise<ReferringDomainRow[]> {
  const params = new URLSearchParams({
    type:           'backlinks_refdomains',
    key:            API_KEY,
    target,
    target_type:    'root_domain',
    display_limit:  String(limit),
    display_sort:   'ascore_desc',
    export_columns: 'domain,ascore,backlinks_num,follows_num,nofollows_num,first_seen,last_seen',
    export_escape:  '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) return []
  const text = await res.text()
  if (!text || text.startsWith('ERROR')) return []

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  return lines.slice(1).map(line => {
    const [domain, ascore, backlinks, follows, noFollows, firstSeen, lastSeen] = line.split(';').map(s => s.replace(/"/g, '').trim())
    return {
      domain:         domain ?? '',
      authorityScore: parseInt(ascore)    || 0,
      backlinks:      parseInt(backlinks) || 0,
      follows:        parseInt(follows)   || 0,
      noFollows:      parseInt(noFollows) || 0,
      firstSeen:      firstSeen ?? '',
      lastSeen:       lastSeen  ?? '',
    }
  }).filter(r => r.domain)
}

export async function getBacklinks(target: string, limit = 100): Promise<BacklinkRow[]> {
  const params = new URLSearchParams({
    type:           'backlinks',
    key:            API_KEY,
    target,
    target_type:    'root_domain',
    display_limit:  String(limit),
    display_sort:   'ascore_desc',
    export_columns: 'source_url,source_title,target_url,anchor,type,dofollow,ascore,external_num,first_seen,last_seen',
    export_escape:  '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) return []
  const text = await res.text()
  if (!text || text.startsWith('ERROR')) return []

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  return lines.slice(1).map(line => {
    const [sourceUrl, , targetUrl, anchor, type, dofollow, ascore, extLinks, firstSeen, lastSeen] = line.split(';').map(s => s.replace(/"/g, '').trim())
    return {
      sourceUrl:      sourceUrl   ?? '',
      sourceDomain:   (() => { try { return new URL(sourceUrl).hostname } catch { return sourceUrl ?? '' } })(),
      targetUrl:      targetUrl   ?? '',
      anchorText:     anchor      ?? '',
      type:           type        ?? 'text',
      dofollow:       dofollow === '1',
      authorityScore: parseInt(ascore)   || 0,
      externalLinks:  parseInt(extLinks) || 0,
      firstSeen:      firstSeen ?? '',
      lastSeen:       lastSeen  ?? '',
    }
  }).filter(r => r.sourceUrl)
}

// ─── Keyword clustering (group by topic) ─────────────────────────────────────
export function clusterKeywords(keywords: KeywordRanking[]): Map<string, KeywordRanking[]> {
  const clusters = new Map<string, KeywordRanking[]>()

  for (const kw of keywords) {
    const words = kw.keyword.toLowerCase().split(' ')
    // Use first meaningful word as cluster key (skip short words)
    const clusterKey = words.find(w => w.length > 3) ?? words[0] ?? 'other'

    if (!clusters.has(clusterKey)) clusters.set(clusterKey, [])
    clusters.get(clusterKey)!.push(kw)
  }

  // Sort clusters by total traffic
  return new Map(
    [...clusters.entries()]
      .sort((a, b) => {
        const sumA = a[1].reduce((s, k) => s + k.trafficPercent, 0)
        const sumB = b[1].reduce((s, k) => s + k.trafficPercent, 0)
        return sumB - sumA
      })
      .slice(0, 20) // top 20 clusters
  )
}

// ── Outreach Discovery ─────────────────────────────────────────────────────────

export interface OutreachCandidate {
  domain:          string
  organicTraffic:  number
  organicKeywords: number
  authorityScore:  number
  rankingUrl:      string   // the specific URL ranking for the keyword
  position:        number
}

// phrase_organic: given a keyword, returns the top-ranking URLs/domains
export async function getKeywordOrganicResults(
  keyword:  string,
  database  = 'us',
  limit     = 30,
): Promise<OutreachCandidate[]> {
  const params = new URLSearchParams({
    type:            'phrase_organic',
    key:             API_KEY,
    phrase:          keyword,
    database,
    display_limit:   String(limit),
    export_columns:  'Dn,Ur,Po,Nq,Tr',
    export_escape:   '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) throw new Error(`SEMrush API error: ${res.status}`)

  const text = await res.text()
  if (text.startsWith('ERROR')) throw new Error(`SEMrush: ${text}`)

  const lines = text.trim().split('\n')
  if (lines.length < 2) return []

  return lines.slice(1).map(line => {
    const [domain, url, position, , traffic] = line.split(';').map(s => s.replace(/"/g, ''))
    return {
      domain:          domain ?? '',
      rankingUrl:      url ?? '',
      position:        parseInt(position) || 0,
      organicTraffic:  parseInt(traffic) || 0,
      organicKeywords: 0,   // enriched separately
      authorityScore:  0,   // enriched separately
    }
  }).filter(r => r.domain)
}

// domain_rank: get authority score + organic traffic for a domain
export async function getDomainAuthority(
  domain:   string,
  database  = 'us',
): Promise<{ authorityScore: number; organicTraffic: number; organicKeywords: number } | null> {
  const params = new URLSearchParams({
    type:            'domain_ranks',
    key:             API_KEY,
    domain,
    database,
    export_columns:  'Dn,Rk,Or,Ot',
    export_escape:   '1',
  })

  const res = await fetch(`${BASE_URL}/?${params}`)
  if (!res.ok) return null

  const text = await res.text()
  if (text.startsWith('ERROR')) return null

  const lines = text.trim().split('\n')
  if (lines.length < 2) return null

  const [, rank, organicKeywords, organicTraffic] = lines[1].split(';').map(s => s.replace(/"/g, ''))

  // SEMrush rank is global rank (lower = better), not authority score
  // Convert to a 0-100 authority proxy: 100 - log10(rank) * 20
  const rankNum = parseInt(rank) || 999_999_999
  const authorityScore = Math.max(0, Math.min(100, Math.round(100 - Math.log10(rankNum) * 11.1)))

  return {
    authorityScore,
    organicTraffic:  parseInt(organicTraffic) || 0,
    organicKeywords: parseInt(organicKeywords) || 0,
  }
}
