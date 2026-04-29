import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { generateAgentBrief } from '@/lib/agents/brief-generator'

export const maxDuration = 60

/**
 * GET /api/cron/process-briefs
 *
 * Picks up any seo_content_briefs stuck in 'draft' status for more than
 * 3 minutes and re-runs Bragi on them. Two auth modes:
 *
 *  1. Vercel cron — Authorization: Bearer CRON_SECRET  (service-level, all owners)
 *  2. User session — normal cookie auth  (own briefs only)
 *
 * Runs max 2 briefs per invocation to stay within the 60s Vercel limit.
 * Scheduled once a day at 3am via vercel.json as a safety net.
 * Also callable manually from the Pipeline Journey UI to unstick briefs.
 */

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  const isCron = isCronAuth(request)

  // Accept either cron auth or user session
  let ownerId: string | null = null
  if (!isCron) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ownerId = await getEffectiveOwnerId(supabase, user.id)
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Find briefs stuck in 'draft' OR 'generating' for more than 30 seconds.
  // 'draft' = after() never fired (or hasn't yet). 'generating' = Bragi started
  // but crashed mid-run. 30s is enough delay that we don't race a healthy run,
  // but short enough that the user-clicked "Process stuck" button and frontend
  // polling can pick up freshly-stuck briefs from a multi-type approve.
  const stuckSince = new Date(Date.now() - 30 * 1000).toISOString()

  let query = db
    .from('seo_content_briefs')
    .select('id, owner_user_id, page, primary_keyword, brief_type, notes')
    .in('status', ['draft', 'generating'])
    .lt('updated_at', stuckSince)
    .order('updated_at', { ascending: true })
    .limit(1) // process 1 per run — Bragi+Tyr is 25-40s; doing 2 risks timeout

  // If user-triggered, only process their own briefs
  if (ownerId) {
    query = query.eq('owner_user_id', ownerId)
  }

  const { data: stuck, error } = await query

  if (error) {
    console.error('[process-briefs] DB error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!stuck?.length) {
    return NextResponse.json({ processed: 0, remaining: 0, message: 'No stuck briefs found' })
  }

  const results: { briefId: string; result: string }[] = []

  for (const brief of stuck) {
    console.log(`[process-briefs] Processing stuck brief: ${brief.id} (${brief.primary_keyword})`)
    try {
      await generateAgentBrief({
        briefId:   brief.id,
        ownerId:   brief.owner_user_id,
        keyword:   brief.primary_keyword ?? brief.page ?? 'unknown',
        pageUrl:   brief.page ?? '',
        briefType: brief.brief_type ?? 'category_page',
        notes:     brief.notes ?? undefined,
      })

      // Update linked opportunity to brief_ready. Try TWO paths because the
      // approve route's brief_id linking has been failing silently in some cases:
      //   1. Direct FK link: opp.brief_id = brief.id
      //   2. Notes-tag fallback: brief.notes contains "Queued from Opportunity: ... (oppId)"
      // The fallback rescues opps where brief_id failed to be set on insert.
      let oppToUpdate: { id: string; status: string } | null = null

      const { data: oppsByFk } = await db
        .from('seo_opportunities')
        .select('id, status')
        .eq('brief_id', brief.id)
        .eq('owner_user_id', brief.owner_user_id)
        .limit(1)

      if (oppsByFk?.[0]) {
        oppToUpdate = oppsByFk[0]
      } else {
        // Fallback: extract opp_id from notes tag and look it up
        const tagMatch = brief.notes?.match(/Queued from Opportunity:.*\(([0-9a-f-]{36})\)/)
        const taggedOppId = tagMatch?.[1]
        if (taggedOppId) {
          const { data: oppsByTag } = await db
            .from('seo_opportunities')
            .select('id, status')
            .eq('id', taggedOppId)
            .eq('owner_user_id', brief.owner_user_id)
            .limit(1)
          if (oppsByTag?.[0]) {
            oppToUpdate = oppsByTag[0]
            // Heal the missing brief_id link while we're here
            await db
              .from('seo_opportunities')
              .update({ brief_id: brief.id })
              .eq('id', taggedOppId)
              .eq('owner_user_id', brief.owner_user_id)
          }
        }
      }

      if (oppToUpdate && !['brief_ready', 'published'].includes(oppToUpdate.status)) {
        await db
          .from('seo_opportunities')
          .update({ status: 'brief_ready', updated_at: new Date().toISOString() })
          .eq('id', oppToUpdate.id)
      }

      results.push({ briefId: brief.id, result: 'ok' })
    } catch (err) {
      console.error(`[process-briefs] Failed for brief ${brief.id}:`, err)
      results.push({ briefId: brief.id, result: String(err) })
    }
  }

  // Count remaining stuck briefs so the UI can decide whether to loop
  let remainingQuery = db
    .from('seo_content_briefs')
    .select('id', { count: 'exact', head: true })
    .in('status', ['draft', 'generating'])
    .lt('updated_at', stuckSince)

  if (ownerId) remainingQuery = remainingQuery.eq('owner_user_id', ownerId)
  const { count: remaining } = await remainingQuery

  return NextResponse.json({ processed: results.length, remaining: remaining ?? 0, results })
}
