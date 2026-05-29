import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runLearningAggregator } from '@/lib/learn/aggregator'

export const maxDuration = 300

/**
 * GET /api/cron/learning-aggregator-weekly
 *
 * Senin 04:00 UTC (11:00 WIB) — scan past 7d brief_review_feedback per
 * (owner × site), cluster by reason bucket, propose KB rules. Approved
 * rules land in /knowledge-base/proposals for human 1-click accept.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: owners } = await db.from('gsc_connections').select('user_id')
  const uniqueOwners = Array.from(new Set((owners ?? []).map(o => o.user_id as string)))

  const { data: sites } = await db.from('site_configs').select('slug').eq('is_active', true)
  const activeSlugs = ((sites ?? []).map(s => String(s.slug))) as string[]
  if (activeSlugs.length === 0) activeSlugs.push('g2g')

  const summary: Array<{ owner: string; site: string; proposals: number; clusters: number; feedback: number; errors: number }> = []

  for (const ownerId of uniqueOwners) {
    for (const site of activeSlugs) {
      try {
        const res = await runLearningAggregator(db, ownerId, site, 7)
        summary.push({
          owner:     ownerId,
          site,
          proposals: res.proposals_created,
          clusters:  res.clusters_seen,
          feedback:  res.feedback_scanned,
          errors:    res.errors.length,
        })
      } catch (e) {
        summary.push({
          owner:     ownerId,
          site,
          proposals: 0,
          clusters:  0,
          feedback:  0,
          errors:    1,
        })
        console.warn(`[learning-aggregator] ${ownerId}/${site}:`, e instanceof Error ? e.message : e)
      }
    }
  }

  return NextResponse.json({ ok: true, summary })
}
