import { createClient } from '@/lib/supabase/server'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSitesList } from '@/lib/gsc/client'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('*')
    .eq('user_id', user.id)
    .single()

  if (!conn) return NextResponse.json({ sites: [] })

  try {
    const auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
    const sites = await getSitesList(auth)
    return NextResponse.json({ sites: sites.map(s => ({ url: s.siteUrl, level: s.permissionLevel })) })
  } catch {
    return NextResponse.json({ sites: [], error: 'Failed to fetch sites' })
  }
}
