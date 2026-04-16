import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: gscConn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', user.id)
    .single()

  return NextResponse.json({
    gsc: {
      connected: !!gscConn,
      siteUrl: gscConn?.site_url ?? null,
    },
    ga4: {
      connected: !!process.env.GA4_PROPERTY_ID,
      propertyId: process.env.GA4_PROPERTY_ID ?? null,
    },
    slack: {
      connected: !!process.env.SLACK_WEBHOOK_URL,
    },
    semrush: {
      connected: !!process.env.SEMRUSH_API_KEY,
    },
  })
}
