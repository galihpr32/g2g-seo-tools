import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * POST /api/g2g-catalog/decorate
 * Body: { relation_ids: string[] }   — typically the 100 IDs currently visible
 *
 * Returns three sets so the product browser can render workspace-state badges
 * without N round-trips:
 *   { tiered: [...], content: [...], uploaded: [...] }
 *
 * Lightweight: 3 indexed queries with the IN-list pre-bounded by the caller.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { relation_ids?: string[] }
  const ids = Array.isArray(body.relation_ids)
    ? body.relation_ids.filter(s => typeof s === 'string' && s.length > 0).slice(0, 500)
    : []
  if (ids.length === 0) {
    return NextResponse.json({ tiered: [], content: [], uploaded: [] })
  }

  const [tier, content, uploaded] = await Promise.all([
    db.from('product_tiers')
      .select('relation_id')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .in('relation_id', ids),
    db.from('product_content_queue')
      .select('relation_id')
      .eq('owner_user_id', ownerId)
      .eq('status', 'generated')
      .in('relation_id', ids),
    db.from('product_content_queue')
      .select('relation_id')
      .eq('owner_user_id', ownerId)
      .eq('cms_upload_status', 'uploaded')
      .in('relation_id', ids),
  ])

  return NextResponse.json({
    tiered:   Array.from(new Set((tier.data     ?? []).map(r => r.relation_id).filter(Boolean) as string[])),
    content:  Array.from(new Set((content.data  ?? []).map(r => r.relation_id).filter(Boolean) as string[])),
    uploaded: Array.from(new Set((uploaded.data ?? []).map(r => r.relation_id).filter(Boolean) as string[])),
  })
}
