import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * POST /api/competitive/keyword-gap/send-to-pipeline
 *
 * Manual override: explicitly push a list of gap rows into Pipeline Journey,
 * bypassing the SV threshold auto-push. Used by the keyword-gap UI when the
 * user multi-selects gaps below the auto-push threshold but still wants them
 * in the pipeline.
 *
 * Emits agent_actions with `agent_key='loki'` so the existing Saga aggregator
 * picks them up on its next run and creates opportunities.
 *
 * Body:
 *   {
 *     gaps: Array<{
 *       keyword:              string
 *       competitor_domain:    string
 *       competitor_url?:      string | null
 *       competitor_position?: number
 *       our_position?:        number | null
 *       search_volume?:       number
 *       cpc?:                 number
 *     }>
 *     site_slug?: string   (default 'g2g')
 *   }
 *
 * Returns: { pushed: number, skipped_existing: number, run_id }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    gaps?: Array<{
      keyword:              string
      competitor_domain:    string
      competitor_url?:      string | null
      competitor_position?: number
      our_position?:        number | null
      search_volume?:       number
      cpc?:                 number
    }>
    site_slug?: string
  }

  if (!Array.isArray(body.gaps) || body.gaps.length === 0) {
    return NextResponse.json({ error: 'gaps array required' }, { status: 400 })
  }
  if (body.gaps.length > 30) {
    return NextResponse.json({ error: 'max 30 gaps per request — split across multiple calls' }, { status: 400 })
  }

  const siteSlug = body.site_slug ?? 'g2g'

  // Skip-list to avoid double-emit on same keyword in last 14d
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentActions } = await db
    .from('agent_actions')
    .select('data')
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'loki')
    .gte('created_at', fourteenDaysAgo)
    .limit(500)

  const skipKeywords = new Set<string>()
  for (const a of recentActions ?? []) {
    const kw = (a.data as { keyword?: string } | null)?.keyword
    if (kw) skipKeywords.add(kw.toLowerCase())
  }

  const syntheticRunId = `manual-kgap-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const rowsToInsert = body.gaps
    .filter(g => g.keyword && !skipKeywords.has(g.keyword.toLowerCase()))
    .map(g => ({
      owner_user_id: ownerId,
      agent_key:     'loki',
      run_id:        syntheticRunId,
      site_slug:     siteSlug,
      action_type:   'add_action_item',
      title:         `Keyword gap: "${g.keyword}" — ${g.competitor_domain} #${g.competitor_position ?? '?'} (user-selected)`,
      description:   `User pushed this gap from manual keyword-gap analysis. ${g.competitor_domain} ranks #${g.competitor_position ?? '?'} for "${g.keyword}" (${(g.search_volume ?? 0).toLocaleString()} SV). ${g.our_position ? `We rank #${g.our_position}.` : `We don't rank in top 30.`}`,
      priority:      (g.search_volume ?? 0) >= 5000 ? 'high' : (g.search_volume ?? 0) >= 1000 ? 'medium' : 'low',
      data: {
        keyword:             g.keyword,
        competitor_domain:   g.competitor_domain,
        competitor_url:      g.competitor_url ?? null,
        competitor_position: g.competitor_position ?? null,
        our_position:        g.our_position ?? null,
        search_volume:       g.search_volume ?? 0,
        cpc:                 g.cpc ?? 0,
        action_type:         g.our_position && g.our_position < 50 ? 'on_page' : 'new_page',
        source:              'manual_user_pushed',
      },
    }))

  const skippedExisting = body.gaps.length - rowsToInsert.length

  if (rowsToInsert.length === 0) {
    return NextResponse.json({
      pushed:           0,
      skipped_existing: skippedExisting,
      run_id:           syntheticRunId,
      message:          'All selected gaps already exist as recent agent_actions. Nothing pushed.',
    })
  }

  const { error } = await db.from('agent_actions').insert(rowsToInsert)
  if (error) {
    console.error('[keyword-gap/send-to-pipeline] insert failed:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    pushed:           rowsToInsert.length,
    skipped_existing: skippedExisting,
    run_id:           syntheticRunId,
  })
}
