// Sprint #376 BOSS.VIEW.COUNTRY.FUZZY — debug probe.
// GET /api/reports/friday-kpi/boss-view/debug-countries?site=g2g
//
// Returns the raw country dim values + totalRevenue per country that GA4
// returns for the past 7 days, with Organic Search filter. Lets us see
// exactly what country format strings GA4 is using on this property so we
// can extend classifyMarket() if there's a variant we missed.
//
// Auth-gated. NOT linked from the UI — purely a one-off debugging tool.

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'

export const runtime     = 'nodejs'
export const maxDuration = 30
export const dynamic     = 'force-dynamic'

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const site = searchParams.get('site') ?? 'g2g'

  const { data: cfg } = await db
    .from('site_configs')
    .select('ga4_property_id')
    .eq('slug', site)
    .maybeSingle()
  if (!cfg?.ga4_property_id) return NextResponse.json({ error: `No GA4 property for site ${site}` }, { status: 400 })

  const { data: conn } = await db
    .from('gsc_connections')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()
  if (!conn?.access_token) return NextResponse.json({ error: 'No GSC/GA4 OAuth' }, { status: 400 })

  const auth = await getRefreshedClient(
    conn.access_token as string,
    conn.refresh_token as string,
    (conn.expires_at as string | null) ?? new Date(0).toISOString(),
  )

  // Cur week — last 7 days. Two views:
  //   1. dim=['country'] no channel filter — total revenue by country
  //   2. dim=['country','sessionDefaultChannelGroup'] — split by channel too
  const [respAllChannels, respOrganicOnly] = await Promise.all([
    getGA4Report(auth, cfg.ga4_property_id as string, '7daysAgo', 'yesterday',
      ['country'], ['totalRevenue', 'sessions'], 50),
    getGA4Report(auth, cfg.ga4_property_id as string, '7daysAgo', 'yesterday',
      ['country', 'sessionDefaultChannelGroup'], ['totalRevenue', 'sessions'], 200),
  ])

  const allRows = parseGA4Rows(respAllChannels).map(r => ({
    country:   r.country,
    revenue:   parseFloat(r.totalRevenue ?? '0'),
    sessions:  parseInt(r.sessions ?? '0'),
  }))

  const organicRows = parseGA4Rows(respOrganicOnly)
    .filter(r => (r.sessionDefaultChannelGroup ?? '').toLowerCase().includes('organic'))
    .map(r => ({
      country:   r.country,
      channel:   r.sessionDefaultChannelGroup,
      revenue:   parseFloat(r.totalRevenue ?? '0'),
      sessions:  parseInt(r.sessions ?? '0'),
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 25)

  return NextResponse.json({
    site,
    range: '7daysAgo..yesterday',
    allChannelsByCountry: allRows.slice(0, 25),
    organicSearchByCountry: organicRows,
    note: 'Eyeball the country values + revenue. classifyMarket() in boss-view.ts must match these strings for US/ID to bucket correctly.',
  })
}
