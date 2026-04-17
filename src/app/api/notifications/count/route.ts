import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

// ── GET /api/notifications/count ─────────────────────────────────────────────
// Returns total notification count for the badge in the sidebar.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ count: 0 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .maybeSingle()

  const siteUrl = conn?.site_url

  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const etaThreshold   = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [staleRes, unassignedRes, etaRes] = await Promise.all([
    siteUrl
      ? supabase.from('seo_action_items')
          .select('id', { count: 'exact', head: true })
          .eq('site_url', siteUrl).eq('status', 'in_progress')
          .lt('created_at', staleThreshold)
      : Promise.resolve({ count: 0 }),

    siteUrl
      ? supabase.from('seo_action_items')
          .select('id', { count: 'exact', head: true })
          .eq('site_url', siteUrl).eq('status', 'in_progress')
          .is('assigned_to', null)
      : Promise.resolve({ count: 0 }),

    supabase.from('campaign_pages')
      .select('id', { count: 'exact', head: true })
      .eq('campaigns.owner_user_id', ownerId)
      .neq('status', 'done')
      .not('eta', 'is', null)
      .lte('eta', etaThreshold),
  ])

  // stale + unassigned may overlap — use max heuristic (not critical to be exact)
  const stale      = staleRes.count ?? 0
  const unassigned = unassignedRes.count ?? 0
  const eta        = etaRes.count ?? 0

  // Can't easily de-duplicate stale/unassigned without fetching rows, so sum with cap
  const count = stale + unassigned + eta

  return NextResponse.json({ count })
}
