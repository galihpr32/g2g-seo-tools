import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runClusterBuilder } from '@/lib/agents/saga'

export const maxDuration = 300

/**
 * GET /api/cron/saga-clusters?site=<slug>
 *
 * Monthly cron — rebuilds the brand→sub-product cluster hierarchy for one
 * site (or every active site if no `?site=` param).
 *
 * Runs `runClusterBuilder()` once per (owner, site) pair. Token cost is
 * controlled by the builder's `maxKeywordsPerRun` (500) — typical run is
 * 17 Sonnet batches ≈ $0.05/site.
 *
 * Per-site invocation pattern (matches Task #25 / PSI cron) — keeps the
 * function under Vercel's 300s ceiling. The matching GitHub Action loops
 * over sites via matrix strategy.
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const reqUrl = new URL(req.url)
  const siteFilter = reqUrl.searchParams.get('site')

  let sitesQuery = db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)
  if (siteFilter) sitesQuery = sitesQuery.eq('slug', siteFilter)

  const { data: sites } = await sitesQuery
  if (!sites?.length) {
    return NextResponse.json({ error: `No active sites${siteFilter ? ` matching slug=${siteFilter}` : ''}` }, { status: 500 })
  }

  // Determine owners per site — only owners with at least one tracked_product
  // qualify, since the builder needs source signal to do anything useful.
  const runs: Array<{ site: string; ownerId: string; ok: boolean; result?: unknown; error?: string }> = []

  for (const site of sites) {
    const siteSlug = String(site.slug)
    const { data: owners } = await db
      .from('tracked_products')
      .select('owner_user_id')
      .eq('site_slug', siteSlug)
      .eq('active', true)
      .limit(1000)

    const uniqueOwners = Array.from(new Set((owners ?? []).map(o => String(o.owner_user_id))))
    if (uniqueOwners.length === 0) {
      runs.push({ site: siteSlug, ownerId: '*', ok: false, error: 'no active tracked_products owners' })
      continue
    }

    for (const ownerId of uniqueOwners) {
      try {
        const result = await runClusterBuilder(ownerId, siteSlug, { trigger: 'cron' })
        runs.push({ site: siteSlug, ownerId, ok: result.warnings.length === 0, result })
      } catch (err) {
        runs.push({
          site:    siteSlug,
          ownerId,
          ok:      false,
          error:   err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return NextResponse.json({
    ok:   runs.every(r => r.ok),
    when: new Date().toISOString(),
    runs,
  })
}
