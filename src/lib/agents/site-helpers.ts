import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Shared helpers for agent runtime.
 *
 *  - getSiteUrlForSlug: resolve canonical site URL from site_configs (no more
 *    hardcoded `https://g2g.com` scattered across agents/executor)
 *  - normalizeUrl: canonical form for dedup (strip protocol/trailing slash/
 *    www so seo_action_items.page and seo_content_briefs.page align across
 *    absolute vs relative URL formats)
 */

export interface ResolvedSite {
  slug:        string
  domain:      string  // e.g. 'g2g.com'
  siteUrl:     string  // canonical with protocol, e.g. 'https://g2g.com'
  gscProperty: string  // e.g. 'https://www.g2g.com/'
}

/**
 * Resolve a site_slug → siteUrl/domain. Throws on miss so callers can
 * surface the failure to the user instead of silently using g2g.com.
 */
export async function getSiteUrlForSlug(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  slug: string
): Promise<ResolvedSite> {
  const { data, error } = await db
    .from('site_configs')
    .select('slug, favicon_domain, gsc_property')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()

  if (error) throw new Error(`site_configs lookup failed for "${slug}": ${error.message}`)
  if (!data) throw new Error(`No active site_config for slug "${slug}"`)

  const domain = String(data.favicon_domain).toLowerCase()
  return {
    slug:        String(data.slug),
    domain,
    siteUrl:     `https://${domain}`,
    gscProperty: String(data.gsc_property),
  }
}

/**
 * Canonicalise a URL/path for dedup keys.
 * Strips protocol, leading www., trailing slashes. Lowercases host.
 *   https://www.g2g.com/categories/wow-gold/  → g2g.com/categories/wow-gold
 *   /categories/wow-gold                       → categories/wow-gold
 */
export function normalizeUrl(url: string | null | undefined): string {
  if (!url) return ''
  let s = String(url).trim()
  s = s.replace(/^https?:\/\//i, '')
  s = s.replace(/^www\./i, '')
  s = s.replace(/\/+$/, '')
  // lowercase host portion only (keep path case for DBs that index case-sensitive)
  const slash = s.indexOf('/')
  if (slash > 0) {
    s = s.slice(0, slash).toLowerCase() + s.slice(slash)
  } else {
    s = s.toLowerCase()
  }
  return s
}

/**
 * Slugify a free-text term (game name, keyword) into a URL path segment.
 *   "World of Warcraft: Cataclysm" → "world-of-warcraft-cataclysm"
 */
export function slugify(text: string): string {
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build a category page URL for a given site + term. Used by Odin/Bragi when
 * upstream payload doesn't supply a page_url.
 */
export function buildCategoryUrl(siteUrl: string, term: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/categories/${slugify(term)}`
}
