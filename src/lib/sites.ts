import type { SupabaseClient } from '@supabase/supabase-js'

// NOTE: This module is imported from BOTH client and server code (e.g.
// `useSiteSlug` client hook uses `getSiteSlugFromPath`). DO NOT import
// `next/headers` or `next/cookies` here — those are server-only and will
// fail the client build with "depends on next/headers" errors.
// Server-only helpers live in `sites-server.ts`.

export interface SiteConfig {
  id: string
  slug: string
  display_name: string
  favicon_domain: string
  gsc_property: string
  semrush_domain: string
  ga4_property_id: string | null
  is_active: boolean
  sort_order: number
}

/**
 * Fetch a single site config by slug.
 * Returns null if the slug is unknown or inactive.
 */
export async function getSiteConfig(
  supabase: SupabaseClient,
  slug: string
): Promise<SiteConfig | null> {
  const { data } = await supabase
    .from('site_configs')
    .select('*')
    .eq('slug', slug)
    .eq('is_active', true)
    .single()
  return data ?? null
}

/**
 * Fetch all active sites, ordered by sort_order.
 */
export async function getAllSites(
  supabase: SupabaseClient
): Promise<SiteConfig[]> {
  const { data } = await supabase
    .from('site_configs')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  return data ?? []
}

/**
 * Extract site slug from a URL pathname.
 * /g2g/reports/weekly → 'g2g'
 * /offgamers/reports/weekly → 'offgamers'
 * /reports/weekly → 'g2g' (default)
 */
export function getSiteSlugFromPath(
  pathname: string,
  knownSlugs: string[] = ['g2g', 'offgamers']
): string {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length > 0 && knownSlugs.includes(parts[0])) {
    return parts[0]
  }
  return 'g2g'
}

/**
 * Resolve the active site_slug for a server-side API route.
 *
 * Priority order (first match wins) — explicit signals beat implicit ones:
 *   1. `?site=...` query param      — explicit override (rare, used for testing)
 *   2. `?siteSlug=...` query param  — alternate spelling some pages use
 *   3. JSON body `site` / `siteSlug` — POST handlers explicit user intent
 *   4. `active-site` cookie         — implicit user-state default from SiteSwitcher
 *   5. Fallback `'g2g'`             — backwards compatible default
 *
 * Why body > cookie (changed 2026-05-08):
 *   The cookie can be stale across tabs / lag behind a SiteSwitcher click.
 *   When the frontend explicitly sets `body.site` via `useSiteSlug()`, that
 *   represents the user's CURRENT visual state — it should win over a stale
 *   cookie. Caused a real bug where Mimir Council generated OffGamers
 *   proposals while UI displayed G2G.
 *
 * @example
 *   // GET handler
 *   const siteSlug = resolveSiteSlugFromRequest(req)
 *
 *   // POST handler (uses body — body should win over stale cookie)
 *   const body = await req.json()
 *   const siteSlug = resolveSiteSlugFromRequest(req, body)
 */
export function resolveSiteSlugFromRequest(
  req: Request,
  body?: Record<string, unknown>,
  knownSlugs: string[] = ['g2g', 'offgamers'],
): string {
  // 1. Query param (explicit override, rare)
  try {
    const url   = new URL(req.url)
    const qSite = url.searchParams.get('site') ?? url.searchParams.get('siteSlug')
    if (qSite && knownSlugs.includes(qSite)) return qSite
  } catch { /* invalid URL — fall through */ }

  // 2. Body (POST explicit — user's CURRENT visual state, beats stale cookie)
  if (body) {
    const bSite = (body.site as string | undefined) ?? (body.siteSlug as string | undefined)
    if (bSite && knownSlugs.includes(bSite)) return bSite
  }

  // 3. Cookie (implicit default from SiteSwitcher)
  const cookieMatch = req.headers.get('cookie')?.match(/(?:^|;\s*)active-site=([^;]+)/)
  const cookieSite  = cookieMatch?.[1]
  if (cookieSite && knownSlugs.includes(cookieSite)) return cookieSite

  // 4. Default
  return 'g2g'
}
