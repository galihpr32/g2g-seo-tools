import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/g2g-catalog/search?q=<text>&service=<category>&limit=20&include_inactive=0
 *
 * Powers:
 *   • Tier admin typeahead         (Sprint CATALOG.7)
 *   • Product browser page         (Sprint CATALOG.12)
 *   • Bulk-add by category preview (Sprint CATALOG.8)
 *
 * Search strategy: case-insensitive ILIKE on brand_name + brand_id. Falls
 * back to plain "all" when q is empty (paginated list).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const q       = (searchParams.get('q') ?? '').trim()
  const service = (searchParams.get('service') ?? '').trim()
  const limit   = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))
  const includeInactive = searchParams.get('include_inactive') === '1'

  // Sprint OG.CATALOG — scope search to active site (default 'g2g')
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  let query = db
    .from('g2g_products')
    .select('relation_id, service_id, brand_id, service_name, brand_name, cms_created_at, is_active')
    .eq('site_slug', siteSlug)

  if (!includeInactive) query = query.eq('is_active', true)
  if (service)          query = query.eq('service_name', service)
  if (q) {
    // OR clause: brand_name ILIKE %q% OR brand_id ILIKE %q%
    // (Supabase .or syntax wants comma-separated filters with no spaces)
    const safe = q.replace(/[%,()]/g, ' ')
    query = query.or(`brand_name.ilike.%${safe}%,brand_id.ilike.%${safe}%`)
  }

  const { data, error } = await query
    .order('brand_name', { ascending: true })
    .limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ results: data ?? [], count: data?.length ?? 0 })
}
