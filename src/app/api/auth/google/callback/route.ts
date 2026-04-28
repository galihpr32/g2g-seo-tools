import { getTokensFromCode, getOAuthClient } from '@/lib/gsc/auth'
import { getSitesList } from '@/lib/gsc/client'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'

const KNOWN_SLUGS = ['g2g', 'offgamers']
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code  = searchParams.get('code')
  const state = searchParams.get('state') ?? ''  // site slug passed from /api/auth/google

  if (!code) {
    return NextResponse.redirect(`${APP_URL}/dashboard?error=no_code`)
  }

  try {
    const tokens = await getTokensFromCode(code)

    // Fetch all GSC properties the Google account can access
    const auth = getOAuthClient()
    auth.setCredentials(tokens)
    const sites = await getSitesList(auth)

    // Determine which site slug is being reconnected (from OAuth state)
    const siteSlug = KNOWN_SLUGS.includes(state) ? state : 'g2g'

    // Look up the expected GSC property identifier for this site from site_configs
    const db = createServiceClient()
    const { data: siteConfig } = await db
      .from('site_configs')
      .select('gsc_property')
      .eq('slug', siteSlug)
      .eq('is_active', true)
      .maybeSingle()

    // Find the matching GSC property.
    // site_configs.gsc_property might be 'sc-domain:g2g.com' or 'https://www.g2g.com/'
    // We match flexibly: check if the GSC siteUrl contains the configured gsc_property value
    // or vice-versa (handles both domain and URL-prefix formats).
    let siteUrl = sites[0]?.siteUrl ?? ''
    if (siteConfig?.gsc_property && sites.length > 0) {
      const expected = siteConfig.gsc_property.toLowerCase().replace(/\/$/, '')
      const match = sites.find(s => {
        const candidate = (s.siteUrl ?? '').toLowerCase().replace(/\/$/, '')
        return candidate === expected
          || candidate.includes(expected.replace('sc-domain:', '').replace('https://www.', '').replace('https://', ''))
          || expected.includes(candidate.replace('sc-domain:', '').replace('https://www.', '').replace('https://', ''))
      })
      if (match) siteUrl = match.siteUrl ?? siteUrl
      // If no match found: keep sites[0] as fallback (connection still works, site_url just may be wrong)
    }

    // Save / update the connection — tokens + whichever site_url we resolved
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.redirect(`${APP_URL}/login`)

    await supabase.from('gsc_connections').upsert({
      user_id:       user.id,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      site_url:      siteUrl,
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'user_id' })

    return NextResponse.redirect(`${APP_URL}/settings?connected=${siteSlug}`)
  } catch (err) {
    console.error('GSC OAuth error:', err)
    return NextResponse.redirect(`${APP_URL}/dashboard?error=oauth_failed`)
  }
}
