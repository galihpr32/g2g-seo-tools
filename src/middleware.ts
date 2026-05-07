import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const KNOWN_SITES = ['g2g', 'offgamers'] as const
type SiteSlug = typeof KNOWN_SITES[number]
const SITE_COOKIE = 'active-site'

/**
 * Site-prefix routing — Sprint 11 / URL Prefix.
 *
 * URLs of the form `/<site>/<path>` and `/<path>` BOTH work. The middleware
 * normalises behaviour without breaking any existing route:
 *
 *   1. If first path segment is a known site slug, the active-site cookie
 *      is set to that slug. This makes the URL the authoritative signal
 *      for "which brand is the user looking at" — shareable links respect
 *      brand context for the recipient.
 *
 *   2. Some routes ALREADY have an App Router `[site]/...` dynamic segment
 *      (currently `[site]/reports/weekly` and `[site]/reports/monthly`).
 *      For those, we DO NOT rewrite — Next.js's own dynamic-route matcher
 *      handles them, and the `[site]` page reads the segment from `params`.
 *
 *   3. For every other prefixed URL (e.g. `/g2g/clusters`,
 *      `/offgamers/competitive/keyword-gap`), there's no `[site]/...`
 *      version of the page. The middleware rewrites internally to the
 *      un-prefixed equivalent so the existing un-prefixed page renders.
 *      The page reads the site via `useSiteSlug()` / `resolveSiteSlugFromRequest()`
 *      which both respect the freshly-set cookie.
 *
 *   4. Un-prefixed URLs (`/clusters`, `/dashboard`) continue to work
 *      exactly as before — middleware passes them through with no
 *      changes other than the auth gate.
 *
 * Net effect: URL prefix is purely additive. Every legacy bookmark, link,
 * OAuth callback, and Slack message that references a non-prefixed URL
 * keeps working. New shareable URLs use the prefix to pin brand context.
 */

/**
 * Paths that have an App Router `[site]/...` dynamic segment route. When a
 * prefixed URL maps to one of these, we DON'T rewrite — Next.js's dynamic
 * routing handles it and the page receives the slug via `params.site`.
 *
 * Keep this in sync with `src/app/(dashboard)/[site]/...` directory layout.
 * Tested by visiting `/g2g/reports/weekly` and confirming the page renders.
 */
const DYNAMIC_SITE_PATHS: string[] = [
  '/reports/weekly',
  '/reports/monthly',
]

function isSiteSlug(s: string): s is SiteSlug {
  return (KNOWN_SITES as readonly string[]).includes(s)
}

function isDynamicSitePath(strippedPath: string): boolean {
  return DYNAMIC_SITE_PATHS.some(p => strippedPath === p || strippedPath.startsWith(p + '/'))
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const segments = pathname.split('/').filter(Boolean)

  // ── 1. Detect site prefix ────────────────────────────────────────────────-
  let detectedSlug: SiteSlug | null = null
  let strippedPath = pathname
  if (segments.length > 0 && isSiteSlug(segments[0])) {
    detectedSlug = segments[0]
    strippedPath = '/' + segments.slice(1).join('/')
    if (strippedPath === '') strippedPath = '/'

    // Push the freshly-detected slug onto the REQUEST cookie jar so the
    // downstream page render (RSC `cookies().get('active-site')`,
    // resolveSiteSlugFromRequest, Supabase auth) sees the new value during
    // this same request. Without this the cookie only commits on the
    // response and the page renders with the OLD cookie value on first
    // visit. Bug found 2026-05-08 audit.
    request.cookies.set(SITE_COOKIE, detectedSlug)
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // ── 2. Auth gating — same logic as before, just respects prefix ─────────-
  // We gate on the STRIPPED path so /g2g/dashboard and /dashboard behave
  // identically. Login redirects preserve the prefix when present so the
  // user lands back in their brand context after auth.
  const isAuthPage  = strippedPath.startsWith('/login')
  const isDashboard = strippedPath.startsWith('/dashboard') ||
                      strippedPath.startsWith('/gsc') ||
                      strippedPath.startsWith('/ga4')

  if (!user && isDashboard) {
    const url = request.nextUrl.clone()
    url.pathname = detectedSlug ? `/${detectedSlug}/login` : '/login'
    return NextResponse.redirect(url)
  }
  if (user && isAuthPage) {
    const url = request.nextUrl.clone()
    url.pathname = detectedSlug ? `/${detectedSlug}/dashboard` : '/dashboard'
    return NextResponse.redirect(url)
  }

  // ── 3. No prefix? Pass through unchanged (legacy URL behaviour) ─────────-
  if (!detectedSlug) return supabaseResponse

  // ── 4. Prefix present — decide rewrite vs pass-through ──────────────────-
  // If the underlying route is a `[site]/...` dynamic segment, we let
  // Next.js handle it natively (don't rewrite). Otherwise we rewrite to
  // the un-prefixed equivalent so the regular page renders.
  const useDynamicRoute = isDynamicSitePath(strippedPath)

  let baseResponse: NextResponse
  if (useDynamicRoute) {
    // Dynamic route handles the prefix natively — no rewrite, just continue.
    baseResponse = supabaseResponse
  } else {
    const rewriteUrl = request.nextUrl.clone()
    rewriteUrl.pathname = strippedPath
    baseResponse = NextResponse.rewrite(rewriteUrl, { request })
    // Mirror auth cookies through the rewrite response
    for (const c of supabaseResponse.cookies.getAll()) {
      baseResponse.cookies.set(c.name, c.value, c)
    }
  }

  // Either way: pin the active-site cookie from the URL prefix. This is
  // what makes shareable URLs respect brand context for recipients.
  baseResponse.cookies.set(SITE_COOKIE, detectedSlug, {
    path:     '/',
    sameSite: 'lax',
    maxAge:   60 * 60 * 24 * 365,
  })

  return baseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
