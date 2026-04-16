import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { siteUrl } = await request.json()
  if (!siteUrl) return NextResponse.json({ error: 'siteUrl required' }, { status: 400 })

  await supabase
    .from('gsc_connections')
    .update({ site_url: siteUrl, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  return NextResponse.json({ success: true, siteUrl })
}
