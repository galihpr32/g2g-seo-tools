import { getAuthUrl } from '@/lib/gsc/auth'
import { NextRequest, NextResponse } from 'next/server'

const KNOWN_SLUGS = ['g2g', 'offgamers']

export async function GET(req: NextRequest) {
  // Read the active site from cookie (set by SiteSwitcher on every page load/switch)
  const cookieSlug = req.cookies.get('active-site')?.value ?? ''
  const siteSlug   = KNOWN_SLUGS.includes(cookieSlug) ? cookieSlug : 'g2g'

  // Pass siteSlug via OAuth state so the callback knows which site is being reconnected
  const url = getAuthUrl(siteSlug)
  return NextResponse.redirect(url)
}
