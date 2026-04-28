import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { runSagaAggregator } from '@/lib/agents/saga'

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

  let siteSlug    = 'g2g'
  let windowHours = 72
  try {
    const body  = await request.json()
    if (body.site)        siteSlug    = String(body.site)
    if (body.windowHours) windowHours = Number(body.windowHours)
  } catch { /* body is optional */ }

  try {
    const result = await runSagaAggregator(effectiveOwnerId, siteSlug, windowHours)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[aggregate] failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
