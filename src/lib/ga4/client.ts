import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// ─── GA4 Data API ─────────────────────────────────────────────────────────────

/**
 * Sprint #377 — `dimensionFilter` is now passed through. GA4 samples large
 * queries (e.g. dim=[date,country,channel] over 13 weeks generates ~200K
 * row permutations and gets sampled to 25% of actuals). Pre-filtering at
 * the API level via `inListFilter` on country/channel cuts row count to a
 * few hundred → no sampling, full revenue numbers.
 *
 * Shape examples:
 *   filter: {
 *     andGroup: { expressions: [
 *       { filter: { fieldName: 'country', inListFilter: { values: ['United States', 'Indonesia'] } } },
 *       { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'CONTAINS', value: 'Organic' } } },
 *     ] }
 *   }
 *   filter: { filter: { fieldName: 'country', stringFilter: { value: 'United States' } } }
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ga4DimensionFilter = any   // GA4 API type is deep + verbose; we pass through as-is

export async function getGA4Report(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  dimensions: string[],
  metrics: string[],
  limit = 100,
  dimensionFilter?: Ga4DimensionFilter,
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
      ...(dimensionFilter ? { dimensionFilter } : {}),
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

// ─── GA4 Revenue by Landing Page (SEO attribution) ───────────────────────────
// Sessions that started on a landing page via Organic Search → revenue earned in that session
// This is the most SEO-relevant revenue metric: did this page drive purchase intent?
export async function getGA4RevenueByLandingPage(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  limit = 500
) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth })
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'landingPage' }],
      metrics: [
        { name: 'sessions' },
        { name: 'purchaseRevenue' },
        { name: 'transactions' },
        { name: 'engagedSessions' },
      ],
      // Filter to Organic Search channel only
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
      limit: String(limit),
    },
  })
  return parseGA4Rows(res.data)
}

// ─── GA4 Revenue by Page Path (on-page purchase events) ──────────────────────
// Purchase events fired directly on a given page path
// Useful for product/checkout pages where the purchase event fires on the same page
export async function getGA4RevenueByPage(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  limit = 500
) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth })
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'purchaseRevenue' },
        { name: 'transactions' },
        { name: 'screenPageViews' },
      ],
      // Only rows that had at least one purchase
      metricFilter: {
        filter: {
          fieldName: 'transactions',
          numericFilter: { operation: 'GREATER_THAN', value: { int64Value: '0' } },
        },
      },
      orderBys: [{ metric: { metricName: 'purchaseRevenue' }, desc: true }],
      limit: String(limit),
    },
  })
  return parseGA4Rows(res.data)
}

// ─── GA4 Organic Sessions by Page ────────────────────────────────────────────
// Sessions + engagement per page path, filtered to Organic Search
export async function getGA4OrganicSessionsByPage(
  auth: OAuth2Client,
  propertyId: string,
  startDate: string,
  endDate: string,
  limit = 500
) {
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth })
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'screenPageViews' },
      ],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: String(limit),
    },
  })
  return parseGA4Rows(res.data)
}
