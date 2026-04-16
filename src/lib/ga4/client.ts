import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// ─── GA4 Data API ─────────────────────────────────────────────────────────────

export async function getGA4Report(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
  metrics: string[],
  limit = 100
) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth })
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map(name => ({ name })),
      metrics: metrics.map(name => ({ name })),
      limit: String(limit),
      orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
    },
  })
  return res.data
}

export async function getGA4OrganicTraffic(auth: OAuth2Client, propertyId: string) {
  // Weekly organic traffic summary
  const [thisWeek, lastWeek] = await Promise.all([
    getGA4Report(auth, propertyId, '7daysAgo', 'yesterday',
      ['date'],
      ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews'], 7),
    getGA4Report(auth, propertyId, '14daysAgo', '8daysAgo',
      ['date'],
      ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews'], 7),
  ])

  // Top landing pages (organic only)
  const topPages = await getGA4Report(auth, propertyId, '7daysAgo', 'yesterday',
    ['pagePath', 'sessionDefaultChannelGroup'],
    ['sessions', 'engagedSessions', 'bounceRate', 'conversions'], 20)

  return { thisWeek, lastWeek, topPages }
}

export async function getGA4ContentPerformance(auth: OAuth2Client, propertyId: string) {
  // Monthly content performance — find decaying pages
  const [thisMonth, lastMonth] = await Promise.all([
    getGA4Report(auth, propertyId, '30daysAgo', 'yesterday',
      ['pagePath'],
      ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews', 'averageSessionDuration'], 50),
    getGA4Report(auth, propertyId, '60daysAgo', '31daysAgo',
      ['pagePath'],
      ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews', 'averageSessionDuration'], 50),
  ])

  return { thisMonth, lastMonth }
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

export function parseGA4Rows(data: { rows?: { dimensionValues?: { value?: string | null }[], metricValues?: { value?: string | null }[] }[] | null, dimensionHeaders?: { name?: string | null }[], metricHeaders?: { name?: string | null }[] } | null) {
  if (!data?.rows) return []
  const dimHeaders = data.dimensionHeaders?.map(h => h.name ?? '') ?? []
  const metHeaders = data.metricHeaders?.map(h => h.name ?? '') ?? []

  return data.rows.map(row => {
    const obj: Record<string, string> = {}
    row.dimensionValues?.forEach((v, i) => { obj[dimHeaders[i]] = v.value ?? '' })
    row.metricValues?.forEach((v, i) => { obj[metHeaders[i]] = v.value ?? '' })
    return obj
  })
}

export function sumMetric(rows: Record<string, string>[], metric: string) {
  return rows.reduce((sum, r) => sum + parseFloat(r[metric] ?? '0'), 0)
}
