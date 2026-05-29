import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/site-health/psi
 *
 * Returns latest PSI snapshot per page, sorted by performance score asc
 * so worst performers surface first.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { data: snaps } = await db
    .from('psi_snapshots')
    .select('page_url, snapshot_date, strategy, performance, accessibility, best_practices, seo, lcp_ms, inp_ms, cls, ttfb_ms, fcp_ms, cwv_passed, top_issues, http_status, error')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('strategy', 'mobile')
    .order('snapshot_date', { ascending: false })
    .limit(200)

  const latestByPage = new Map<string, NonNullable<typeof snaps>[number]>()
  for (const s of snaps ?? []) {
    if (!latestByPage.has(String(s.page_url))) latestByPage.set(String(s.page_url), s)
  }
  const latest = Array.from(latestByPage.values())
    .sort((a, b) => (a.performance ?? 100) - (b.performance ?? 100))

  // Aggregate stats
  const cwvPass    = latest.filter(s => s.cwv_passed === true).length
  const cwvFail    = latest.filter(s => s.cwv_passed === false).length
  const perfScores = latest.map(s => s.performance).filter((p): p is number => p != null)
  const medianPerf = perfScores.length > 0
    ? perfScores.sort((a, b) => a - b)[Math.floor(perfScores.length / 2)]
    : null

  return NextResponse.json({
    ok:    true,
    stats: {
      total:        latest.length,
      cwv_pass:     cwvPass,
      cwv_fail:     cwvFail,
      median_perf:  medianPerf,
    },
    snapshots: latest,
  })
}
