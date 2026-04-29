import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateAgentBrief } from '@/lib/agents/brief-generator'

export const maxDuration = 60

/**
 * GET /api/cron/process-briefs
 *
 * Picks up any seo_content_briefs that are stuck in 'draft' status for
 * more than 3 minutes (i.e., after() failed or the Vercel lambda was killed
 * before Bragi could finish) and re-runs generation for them.
 *
 * Runs one brief per invocation to stay within the 60s timeout.
 * Scheduled every 5 minutes via vercel.json cron.
 *
 * Also runs for the initial "draft" state where after() may not have fired.
 */

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Find briefs stuck in 'draft' for more than 3 minutes
  // 'generating' means Bragi is currently running — skip those
  const stuckSince = new Date(Date.now() - 3 * 60 * 1000).toISOString()

  const { data: stuck, error } = await db
    .from('seo_content_briefs')
    .select('id, owner_user_id, page, primary_keyword, brief_type, notes')
    .eq('status', 'draft')
    .lt('updated_at', stuckSince)
    .order('updated_at', { ascending: true })
    .limit(2) // process max 2 per run to stay within 60s

  if (error) {
    console.error('[process-briefs] DB error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!stuck?.length) {
    return NextResponse.json({ processed: 0, message: 'No stuck briefs found' })
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

      // Update linked opportunity to brief_ready
      const { data: opps } = await db
        .from('seo_opportunities')
        .select('id, status')
        .eq('brief_id', brief.id)
        .eq('owner_user_id', brief.owner_user_id)
        .limit(1)

      if (opps?.[0] && opps[0].status !== 'brief_ready') {
        await db
          .from('seo_opportunities')
          .update({ status: 'brief_ready', updated_at: new Date().toISOString() })
          .eq('id', opps[0].id)
      }

      results.push({ briefId: brief.id, result: 'ok' })
    } catch (err) {
      console.error(`[process-briefs] Failed for brief ${brief.id}:`, err)
      results.push({ briefId: brief.id, result: String(err) })
    }
  }

  return NextResponse.json({ processed: results.length, results })
}
