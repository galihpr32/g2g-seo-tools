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
  database = 'id',
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
export async function getDomainOverview(domain: string, database = 'id') {
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
export async function getCompetitors(domain: string, database = 'id', limit = 10): Promise<CompetitorDomain[]> {
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
