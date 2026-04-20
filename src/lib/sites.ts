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
