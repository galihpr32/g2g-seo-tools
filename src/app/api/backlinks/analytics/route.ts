import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getGA4Report, parseGA4Rows } from '@/lib/ga4/client'

export const maxDuration = 30

/**
 * GET /api/backlinks/analytics?days=30
 *
 * Queries GA4 for referral/organic sessions that originated from tracked backlinks,
 * matched by UTM source or sessionSource against the external_url domain.
 *
 * Returns: { byBacklink: [{ id, site_name, sessions, conversions }] }
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const days = parseInt(searchParams.get('days') ?? '30')

  // Load backlinks
  const { data: backlinks, error: blErr } = await supabase
    .from('paid_backlinks')
    .select('id, site_name, external_url, utm_source, utm_medium, utm_campaign, target_page, live_date')
    .eq('owner_user_id', ownerId)
    .eq('link_status', 'active')

  if (blErr) return NextResponse.json({ error: blErr.message }, { status: 500 })
  if (!backlinks?.length) return NextResponse.json({ byBacklink: [], summary: { totalSessions: 0, totalConversions: 0 } })

  // Get Google OAuth connection
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  const ga4PropertyId = process.env.GA4_PROPERTY_ID
  if (!conn?.access_token || !ga4PropertyId) {
    return NextResponse.json({
      byBacklink: backlinks.map(b => ({ id: b.id, site_name: b.site_name, sessions: null, conversions: null })),
      summary: { totalSessions: null, totalConversions: null },
      note: 'GA4 not connected — connect Google in Settings to see click data.',
    })
  }

  const endDate   = new Date(); endDate.setDate(endDate.getDate() - 1)
  const startDate = new Date(); startDate.setDate(startDate.getDate() - days)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  let ga4Rows: Record<string, string>[] = []
  try {
    const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
    // Query GA4: sessions by source + medium + campaign
    const raw = await getGA4Report(
      auth,
      ga4PropertyId,
      fmt(startDate),
      fmt(endDate),
      ['sessionSource', 'sessionMedium', 'sessionCampaignName'],
      ['sessions', 'conversions'],
      500
    )
    ga4Rows = parseGA4Rows(raw)
  } catch (e) {
    console.warn('[backlinks/analytics] GA4 fetch failed:', e)
    return NextResponse.json({
      byBacklink: backlinks.map(b => ({ id: b.id, site_name: b.site_name, sessions: null, conversions: null })),
      summary: { totalSessions: null, totalConversions: null },
      note: 'GA4 API error — check Google connection in Settings.',
    })
  }

  // Helper: extract root domain from URL
  const rootDomain = (url: string) => {
    try { return new URL(url).hostname.replace(/^www\./, '') }
    catch { return url }
  }

  // Match GA4 rows to each backlink by utm_source or domain
  const byBacklink = backlinks.map(bl => {
    const blDomain = rootDomain(bl.external_url)
    const utmSrc   = (bl.utm_source ?? '').toLowerCase()
    const utmMed   = (bl.utm_medium ?? 'referral').toLowerCase()
    const utmCamp  = (bl.utm_campaign ?? '').toLowerCase()

    // Sum sessions/conversions from matching GA4 rows
    let sessions    = 0
    let conversions = 0

    for (const row of ga4Rows) {
      const rowSrc  = (row.sessionSource  ?? '').toLowerCase()
      const rowMed  = (row.sessionMedium  ?? '').toLowerCase()
      const rowCamp = (row.sessionCampaignName ?? '').toLowerCase()

      // Match priority:
      // 1. UTM campaign match (most specific)
      // 2. UTM source + medium match
      // 3. Domain source match (referral from that site)
      const matchesCampaign = utmCamp && rowCamp && rowCamp.includes(utmCamp)
      const matchesUtm      = utmSrc && rowSrc === utmSrc && (!utmMed || rowMed === utmMed)
      const matchesDomain   = rowSrc === blDomain && rowMed === 'referral'

      if (matchesCampaign || matchesUtm || matchesDomain) {
        sessions    += parseInt(row.sessions    ?? '0')
        conversions += parseInt(row.conversions ?? '0')
      }
    }

    return {
      id:          bl.id,
      site_name:   bl.site_name,
      external_url: bl.external_url,
      target_page: bl.target_page,
      live_date:   bl.live_date,
      sessions,
      conversions,
    }
  })

  byBacklink.sort((a, b) => b.sessions - a.sessions)

  const totalSessions    = byBacklink.reduce((s, b) => s + b.sessions, 0)
  const totalConversions = byBacklink.reduce((s, b) => s + b.conversions, 0)

  return NextResponse.json({
    byBacklink,
    summary: { totalSessions, totalConversions, days },
    period: { start: fmt(startDate), end: fmt(endDate) },
  })
}
