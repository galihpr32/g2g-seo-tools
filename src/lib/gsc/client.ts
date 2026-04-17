import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// ─── Search Analytics (Tasks 1 & 2) ──────────────────────────────────────────

export async function getSearchAnalytics(
  auth: OAuth2Client,
  siteUrl: string,
  startDate: string,
  endDate: string,
  dimensions: string[] = ['page'],
  rowLimit = 1000
) {
  const webmasters = google.webmasters({ version: 'v3', auth })
  const res = await webmasters.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions,
      rowLimit,
    },
  })
  return res.data.rows ?? []
}

export async function getSitesList(auth: OAuth2Client) {
  const webmasters = google.webmasters({ version: 'v3', auth })
  const res = await webmasters.sites.list()
  return res.data.siteEntry ?? []
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

export function getDateRange(daysAgo: number, offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo - offsetDays)
  return d.toISOString().split('T')[0]
}

// ─── Ranking drop analysis (Task 1) ──────────────────────────────────────────

export interface RankingRow {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export interface RankingDrop {
  page: string
  clicksDrop: number
  impressionsDrop: number
  positionChange: number
  currentClicks: number
  previousClicks: number
  currentImpressions: number
  previousImpressions: number
  currentPosition: number
  previousPosition: number
}

export function detectRankingDrops(
  current: RankingRow[],
  previous: RankingRow[],
  threshold = 0.15
): RankingDrop[] {
  const prevMap = new Map(previous.map(r => [r.page, r]))
  const drops: RankingDrop[] = []

  for (const curr of current) {
    const prev = prevMap.get(curr.page)
    if (!prev) continue

    const clicksDrop = prev.clicks > 0 ? (prev.clicks - curr.clicks) / prev.clicks : 0
    const impressionsDrop = prev.impressions > 0 ? (prev.impressions - curr.impressions) / prev.impressions : 0
    const positionChange = curr.position - prev.position

    if (clicksDrop >= threshold || impressionsDrop >= threshold || positionChange >= 5) {
      drops.push({
        page: curr.page,
        clicksDrop,
        impressionsDrop,
        positionChange,
        currentClicks: curr.clicks,
        previousClicks: prev.clicks,
        currentImpressions: curr.impressions,
        previousImpressions: prev.impressions,
        currentPosition: curr.position,
        previousPosition: prev.position,
      })
    }
  }

  return drops.sort((a, b) => b.clicksDrop - a.clicksDrop)
}

// ─── Chrome UX Report API (Task 3) ────────────────────────────────────────────

export interface CWVData {
  origin: string
  lcp: { good: number; ni: number; poor: number }
  cls: { good: number; ni: number; poor: number }
  inp: { good: number; ni: number; poor: number }
}

export async function getCWVData(origin: string): Promise<CWVData | null> {
  const apiKey = process.env.GOOGLE_CLIENT_ID // we use our Google project's API key
  const url = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${process.env.CRUX_API_KEY ?? ''}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin }),
    })

    if (!res.ok) return null
    const data = await res.json()
    const metrics = data.record?.metrics

    if (!metrics) return null

    const parse = (metric: string) => {
      const m = metrics[metric]?.histogram ?? []
      return {
        good: m[0]?.density ?? 0,
        ni: m[1]?.density ?? 0,
        poor: m[2]?.density ?? 0,
      }
    }

    return {
      origin,
      lcp: parse('largest_contentful_paint'),
      cls: parse('cumulative_layout_shift'),
      inp: parse('interaction_to_next_paint'),
    }
  } catch {
    return null
  }
}
