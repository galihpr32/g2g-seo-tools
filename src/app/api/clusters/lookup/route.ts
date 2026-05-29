import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { normalizeUrl } from '@/lib/agents/site-helpers'

/**
 * GET /api/clusters/lookup?page_url=<encoded>&keyword=<encoded>
 *
 * Lightweight lookup used wherever the app wants to display cluster context
 * for a given page or keyword. Returns up to 5 matching cluster
 * (level=1 sub-product) rows, each with their parent brand resolved.
 *
 * Lookup paths:
 *   - page_url provided  → match cluster_pages.page_url (normalised)
 *   - keyword provided   → match keyword_map_clusters.keyword (lowercased)
 *
 * Both can be passed together — results are merged.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url = new URL(req.url)
  const pageUrl = url.searchParams.get('page_url')
  const keyword = url.searchParams.get('keyword')

  if (!pageUrl && !keyword) {
    return NextResponse.json({ error: 'page_url or keyword required' }, { status: 400 })
  }

  const db = createServiceClient()
  const subIds = new Set<string>()

  if (pageUrl) {
    const norm = normalizeUrl(pageUrl)
    // Try exact + normalised match. cluster_pages.page_url stores whatever
    // the source supplied; we accept both forms.
    const { data: pageMatches } = await db
      .from('cluster_pages')
      .select('cluster_id, page_url')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .limit(50)
    for (const r of (pageMatches ?? []) as Array<{ cluster_id: string; page_url: string }>) {
      if (normalizeUrl(r.page_url) === norm) subIds.add(r.cluster_id)
    }
  }

  if (keyword) {
    const { data: kwMatches } = await db
      .from('keyword_map_clusters')
      .select('map_id, keyword, keyword_maps!inner(id, level, site_slug)')
      .eq('owner_user_id', ownerId)
      .ilike('keyword', keyword)
      .eq('keyword_maps.site_slug', siteSlug)
      .eq('keyword_maps.level', 1)
      .limit(20)
    for (const r of (kwMatches ?? []) as Array<{ map_id: string }>) subIds.add(r.map_id)
  }

  if (subIds.size === 0) {
    return NextResponse.json({ clusters: [] })
  }

  const { data: subs } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, level, parent_map_id')
    .in('id', Array.from(subIds))

  const parentIds = Array.from(new Set((subs ?? []).map(s => s.parent_map_id).filter(Boolean) as string[]))
  const { data: brands } = parentIds.length
    ? await db.from('keyword_maps').select('id, topic, topic_slug').in('id', parentIds)
    : { data: [] as Array<{ id: string; topic: string; topic_slug: string }> }
  const brandById = new Map<string, { id: string; topic: string; topic_slug: string }>(
    (brands ?? []).map(b => [b.id, b])
  )

  const clusters = (subs ?? []).slice(0, 5).map(s => ({
    id:         s.id,
    topic:      s.topic,
    topic_slug: s.topic_slug,
    brand:      s.parent_map_id ? brandById.get(s.parent_map_id) ?? null : null,
  }))

  return NextResponse.json({ clusters })
}
