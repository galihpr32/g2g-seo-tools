import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runSagaAggregator } from '@/lib/agents/saga'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

/**
 * POST /api/agents/aggregate
 *
 * Runs the Saga aggregator: reads recent Heimdall/Loki/Odin agent_actions
 * and upserts them into seo_opportunities grouped by topic.
 *
 * Called automatically by AgentStatusPanel after Detection agents complete.
 * Can also be called manually.
 *
 * Body (optional): { site: string, windowHours: number }
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)

  let windowHours = 72
  let body: Record<string, unknown> = {}
  try {
    body = await request.json()
    if (body.windowHours) windowHours = Number(body.windowHours)
  } catch { /* body is optional */ }
  const siteSlug = resolveSiteSlugFromRequest(request, body)

  try {
    const result = await runSagaAggregator(effectiveOwnerId, siteSlug, windowHours)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[aggregate] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
