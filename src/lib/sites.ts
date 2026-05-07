import type { SupabaseClient } from '@supabase/supabase-js'

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
 * Priority order (first match wins):
 *   1. `?site=...` query param   — explicit overrides
 *   2. `?siteSlug=...` query param — alternate spelling some pages use
 *   3. `active-site` cookie        — set by SiteSwitcher in the dashboard
 *   4. JSON body `site` / `siteSlug` — POST handlers can opt-in via {body}
 *   5. Fallback `'g2g'`             — backwards compatible default
 *
 * Use this in every route that touches a site_slug-scoped table so all 8+
 * existing call-sites use the same parsing logic. If you need to read from
 * the request body, pass it as the second arg AFTER you've already
 * `await req.json()`-ed it elsewhere — this helper is sync.
 *
 * @example
 *   // GET handler
 *   const siteSlug = resolveSiteSlugFromRequest(req)
 *
 *   // POST handler (uses body)
 *   const body = await req.json()
 *   const siteSlug = resolveSiteSlugFromRequest(req, body)
 */
export function resolveSiteSlugFromRequest(
  req: Request,
  body?: Record<string, unknown>,
  knownSlugs: string[] = ['g2g', 'offgamers'],
): string {
  // 1. Query param
  try {
    const url   = new URL(req.url)
    const qSite = url.searchParams.get('site') ?? url.searchParams.get('siteSlug')
    if (qSite && knownSlugs.includes(qSite)) return qSite
  } catch { /* invalid URL — fall through */ }

  // 2. Cookie
  const cookieMatch = req.headers.get('cookie')?.match(/(?:^|;\s*)active-site=([^;]+)/)
  const cookieSite  = cookieMatch?.[1]
  if (cookieSite && knownSlugs.includes(cookieSite)) return cookieSite

  // 3. Body (POST handlers — caller passes their already-parsed body)
  if (body) {
    const bSite = (body.site as string | undefined) ?? (body.siteSlug as string | undefined)
    if (bSite && knownSlugs.includes(bSite)) return bSite
  }

  // 4. Default
  return 'g2g'
}
