import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4Report, parseGA4Rows, sumMetric } from '@/lib/ga4/client'

export const maxDuration = 30

// GET /api/ga4/organic-traffic?start=YYYY-MM-DD&end=YYYY-MM-DD
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', ownerId)
    .single()

  const propertyId = process.env.GA4_PROPERTY_ID
  if (!propertyId || !conn?.access_token) {
    return NextResponse.json({ error: 'GA4 not configured' }, { status: 422 })
  }

  const { searchParams } = new URL(req.url)
  const startDate  = searchParams.get('start') ?? '7daysAgo'
  const endDate    = searchParams.get('end')   ?? 'yesterday'

  // Compute comparison range of same length
  let prevStart = '14daysAgo'
  let prevEnd   = '8daysAgo'
  if (searchParams.get('start') && searchParams.get('end')) {
    try {
      const start = new Date(startDate)
      const end   = new Date(endDate)
      const days  = Math.round((end.getTime() - start.getTime()) / 86_400_000)
      const prevEndDate   = new Date(start.getTime() - 86_400_000)
      const prevStartDate = new Date(prevEndDate.getTime() - days * 86_400_000)
      prevStart = prevStartDate.toISOString().split('T')[0]
      prevEnd   = prevEndDate.toISOString().split('T')[0]
    } catch { /* use defaults */ }
  }

  try {
    const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)

    const [thisWeekRaw, lastWeekRaw, topPagesRaw] = await Promise.all([
      getGA4Report(auth, propertyId, startDate, endDate,
        ['date'], ['sessions', 'totalUsers', 'newUsers', 'engagedSessions', 'bounceRate', 'screenPageViews'], 90),
      getGA4Report(auth, propertyId, prevStart, prevEnd,
        ['date'], ['sessions', 'totalUsers', 'engagedSessions', 'bounceRate', 'screenPageViews'], 90),
      getGA4Report(auth, propertyId, startDate, endDate,
        ['pagePath', 'sessionDefaultChannelGroup'],
        ['sessions', 'engagedSessions', 'bounceRate', 'conversions'], 50),
    ])

    const thisWeekRows = parseGA4Rows(thisWeekRaw)
    const lastWeekRows = parseGA4Rows(lastWeekRaw)
    const topPagesRows = parseGA4Rows(topPagesRaw)

    const sessions        = sumMetric(thisWeekRows, 'sessions')
    const prevSessions    = sumMetric(lastWeekRows, 'sessions')
    const totalUsers      = sumMetric(thisWeekRows, 'totalUsers')
    const prevTotalUsers  = sumMetric(lastWeekRows, 'totalUsers')
    const newUsers        = sumMetric(thisWeekRows, 'newUsers')
    const engagedSessions = sumMetric(thisWeekRows, 'engagedSessions')
    const pageViews       = sumMetric(thisWeekRows, 'screenPageViews')
    const avgBounce = thisWeekRows.length > 0
      ? thisWeekRows.reduce((s, r) => s + parseFloat(r.bounceRate ?? '0'), 0) / thisWeekRows.length
      : 0

    const sessionsDiff    = prevSessions > 0 ? ((sessions - prevSessions) / prevSessions) * 100 : null
    const usersDiff       = prevTotalUsers > 0 ? ((totalUsers - prevTotalUsers) / prevTotalUsers) * 100 : null
    const engagementRate  = sessions > 0 ? (engagedSessions / sessions) * 100 : 0

    const dailyRows = [...thisWeekRows].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))

    const organicPageRows = topPagesRows
      .filter(r => (r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic'))
      .map(r => ({
        pagePath:        r.pagePath ?? '',
        sessions:        parseInt(r.sessions ?? '0'),
        engagedSessions: parseInt(r.engagedSessions ?? '0'),
        bounceRate:      parseFloat(r.bounceRate ?? '0'),
        conversions:     parseInt(r.conversions ?? '0'),
      }))

    return NextResponse.json({
      sessions, prevSessions, sessionsDiff,
      totalUsers, prevTotalUsers, usersDiff,
      newUsers,
      engagedSessions, pageViews, avgBounce, engagementRate,
      dailyRows, organicPageRows,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
