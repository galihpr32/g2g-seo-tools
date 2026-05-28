import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 60

/**
 * POST /api/admin/clear-pipeline
 *
 * Wipes the SEO pipeline so the user can re-run all agents on a clean slate
 * (typically right after onboarding the canonical catalog so every fresh opp
 * gets auto-matched to a real product via the Saga aggregator hook).
 *
 * Body:
 *   {
 *     confirm: true,                       // required guard against accidental wipes
 *     scope:   'opps' | 'briefs' | 'all',  // default 'all'
 *   }
 *
 * Scope semantics (owner × site_slug only — never touches other workspaces):
 *   • 'opps'   — delete seo_opportunities
 *   • 'briefs' — delete seo_content_briefs (cascades to brief_outcomes;
 *                opportunities' brief_id is SET NULL by the FK)
 *   • 'all'    — both, in safe order (briefs first → opps)
 *
 * What we DON'T touch:
 *   • agent_actions (raw signals — re-running Heimdall etc. will rebuild
 *     opportunities from these)
 *   • product_content_queue / product_tiers / g2g_products
 *   • outreach_prospects / cannibalization_snapshots / etc.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { confirm?: boolean; scope?: 'opps' | 'briefs' | 'all' }
  if (body.confirm !== true) {
    return NextResponse.json({ error: 'Must pass { confirm: true } to proceed.' }, { status: 400 })
  }
  const scope = body.scope ?? 'all'
  if (!['opps', 'briefs', 'all'].includes(scope)) {
    return NextResponse.json({ error: "scope must be 'opps' | 'briefs' | 'all'" }, { status: 400 })
  }

  const counts = { briefs_deleted: 0, opportunities_deleted: 0 }

  try {
    // ── Briefs FIRST (so the FK from opportunities → briefs SET NULLs cleanly,
    // and brief_outcomes cascades away in one go).
    if (scope === 'briefs' || scope === 'all') {
      const { data: briefRows } = await db
        .from('seo_content_briefs')
        .delete()
        .eq('owner_user_id', ownerId)
        .eq('site_slug', siteSlug)
        .select('id')
      counts.briefs_deleted = briefRows?.length ?? 0
    }

    if (scope === 'opps' || scope === 'all') {
      const { data: oppRows } = await db
        .from('seo_opportunities')
        .delete()
        .eq('owner_user_id', ownerId)
        .eq('site_slug', siteSlug)
        .select('id')
      counts.opportunities_deleted = oppRows?.length ?? 0
    }

    return NextResponse.json({
      ok:    true,
      scope,
      site_slug: siteSlug,
      ...counts,
      message: `Cleared ${counts.opportunities_deleted} opportunities + ${counts.briefs_deleted} briefs for ${siteSlug}. Re-run Heimdall/Loki/Odin to rebuild.`,
    })

  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
      partial_counts: counts,
    }, { status: 500 })
  }
}
