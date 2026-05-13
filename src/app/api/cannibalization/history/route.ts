import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * GET /api/cannibalization/history?query=<encoded>&weeks=12
 *
 * Returns the snapshot timeline for one query so the detail panel can show
 * "worsening" / "stable" / "resolved" trend with sparkline data.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const url = new URL(req.url)
  const query = url.searchParams.get('query')?.trim()
  const weeks = Math.max(1, Math.min(52, Number(url.searchParams.get('weeks') ?? 12)))

  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10)

  const db = createServiceClient()
  const { data, error } = await db
    .from('cannibalization_snapshots')
    .select('snapshot_date, severity, page_count, total_clicks, total_impressions, split_score, recommendation')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('query', query)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const snapshots = data ?? []
  // Trend classifier: compare last 4 vs previous 4 split_scores
  let trend: 'worsening' | 'stable' | 'resolved' | 'unknown' = 'unknown'
  if (snapshots.length >= 2) {
    const last  = snapshots.at(-1)!
    const first = snapshots[0]
    if (last.split_score < first.split_score - 0.15) trend = 'resolved'
    else if (last.split_score > first.split_score + 0.15) trend = 'worsening'
    else trend = 'stable'
    if (last.page_count <= 1) trend = 'resolved'
  }

  return NextResponse.json({
    query,
    snapshots,
    trend,
    weeks_returned: snapshots.length,
  })
}
