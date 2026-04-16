import { getTokensFromCode } from '@/lib/gsc/auth'
import { getSitesList } from '@/lib/gsc/client'
import { getOAuthClient } from '@/lib/gsc/auth'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?error=no_code`)
  }

  try {
    const tokens = await getTokensFromCode(code)

    // Get first GSC site
    const auth = getOAuthClient()
    auth.setCredentials(tokens)
    const sites = await getSitesList(auth)
    const siteUrl = sites[0]?.siteUrl ?? ''

    // Save to Supabase
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/login`)

    await supabase.from('gsc_connections').upsert({
      user_id: user.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      site_url: siteUrl,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?connected=true`)
  } catch (err) {
    console.error('GSC OAuth error:', err)
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL}/dashboard?error=oauth_failed`)
  }
}
