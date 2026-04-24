import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'

export const maxDuration = 30

// GET /api/ga4/content-performance?start=YYYY-MM-DD&end=YYYY-MM-DD
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
  const startDate = searchParams.get('start') ?? '30daysAgo'
  const endDate   = searchParams.get('end')   ?? 'yesterday'

  // Previous period of same length
  let prevStart = '60daysAgo'
  let prevEnd   = '31daysAgo'
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

    const [thisRaw, prevRaw] = await Promise.all([
      getGA4Report(auth, propertyId, startDate, endDate,
        ['pagePath'],
        ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews', 'averageSessionDuration'], 100),
      getGA4Report(auth, propertyId, prevStart, prevEnd,
        ['pagePath'],
        ['sessions', 'engagedSessions', 'bounceRate', 'screenPageViews', 'averageSessionDuration'], 100),
    ])

    const thisRows = parseGA4Rows(thisRaw)
    const prevRows = parseGA4Rows(prevRaw)

    const currentPages = thisRows.map(r => ({
      path:        r.pagePath ?? '',
      sessions:    parseInt(r.sessions ?? '0'),
      engaged:     parseInt(r.engagedSessions ?? '0'),
      bounce:      parseFloat(r.bounceRate ?? '0'),
      views:       parseInt(r.screenPageViews ?? '0'),
      avgDuration: parseFloat(r.averageSessionDuration ?? '0'),
    })).filter(p => p.path)

    const prevEntries = prevRows.map(r => ({
      path:     r.pagePath ?? '',
      sessions: parseInt(r.sessions ?? '0'),
    })).filter(e => e.path)

    return NextResponse.json({ currentPages, prevEntries })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
