import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

// ── GET /api/notifications/count ─────────────────────────────────────────────
// Returns total notification count for the badge in the sidebar.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ count: 0 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Sprint 12: site_url from active brand's site_configs, not gsc_connections.
  const { resolveSiteSlugFromRequest } = await import('@/lib/sites')
  const siteSlug = resolveSiteSlugFromRequest(req)
  const { data: brandSiteConfig } = await db
    .from('site_configs')
    .select('gsc_property')
    .eq('slug', siteSlug)
    .eq('is_active', true)
    .maybeSingle()
  const siteUrl = brandSiteConfig?.gsc_property ?? null

  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const etaThreshold   = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [staleRes, unassignedRes, etaRes, dmcaRes] = await Promise.all([
    siteUrl
      ? db.from('seo_action_items')
          .select('id', { count: 'exact', head: true })
          .eq('site_url', siteUrl).eq('site_slug', siteSlug).eq('status', 'in_progress')
          .lt('created_at', staleThreshold)
      : Promise.resolve({ count: 0 }),

    siteUrl
      ? db.from('seo_action_items')
          .select('id', { count: 'exact', head: true })
          .eq('site_url', siteUrl).eq('site_slug', siteSlug).eq('status', 'in_progress')
          .is('assigned_to', null)
      : Promise.resolve({ count: 0 }),

    db.from('campaign_pages')
      .select('id', { count: 'exact', head: true })
      .eq('campaigns.owner_user_id', ownerId)
      .neq('status', 'done')
      .not('eta', 'is', null)
      .lte('eta', etaThreshold),

    // Count distinct briefs with unresolved DMCA hits
    db.from('dmca_hits')
      .select('brief_id', { count: 'exact', head: false })
      .eq('owner_user_id', ownerId)
      .eq('resolved', false),
  ])

  const stale      = staleRes.count ?? 0
  const unassigned = unassignedRes.count ?? 0
  const eta        = etaRes.count ?? 0
  // DMCA: count distinct briefs (not individual hits)
  const dmcaBriefs = new Set((dmcaRes.data ?? []).map((r: { brief_id: string }) => r.brief_id)).size

  const count = stale + unassigned + eta + dmcaBriefs

  return NextResponse.json({ count })
}
