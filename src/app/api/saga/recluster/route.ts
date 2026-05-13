import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { runClusterBuilder } from '@/lib/agents/saga'

export const maxDuration = 300

/**
 * POST /api/saga/recluster
 *
 * On-demand cluster rebuild. Triggered from the keyword-map / cluster-detail
 * UI when a user wants to re-classify their universe immediately (e.g.
 * after adding several new tracked products).
 *
 * Body (optional): { site?: 'g2g' | 'offgamers', overrides?: ClusterBuilderConfig }
 *   - site: explicit override for the site to rebuild (else uses cookie)
 *   - overrides: caller can pass { maxKeywordsPerRun, classifyBatchSize } etc.
 *
 * Response: ClusterBuilderResult — same shape as the cron run.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)

  const overrides = (body && typeof body === 'object' && 'overrides' in body)
    ? (body.overrides as Record<string, unknown>)
    : {}

  try {
    const result = await runClusterBuilder(ownerId, siteSlug, {
      ...overrides,
      trigger: 'on_demand',
    })
    return NextResponse.json({ ok: true, site: siteSlug, result })
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      site:  siteSlug,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
