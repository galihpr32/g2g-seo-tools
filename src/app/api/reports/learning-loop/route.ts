import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { recommendAutopublishThresholds } from '@/lib/learn/aggregator'

export const maxDuration = 30

/**
 * GET /api/reports/learning-loop?days=30
 *
 * Single payload powering the Learning Loop dashboard:
 *   - feedback_summary: count by bucket + severity in window
 *   - pending_proposals: kb_rule_proposals with source='review_feedback', status='pending'
 *   - threshold_recommendations: per-tier suggested autopublish threshold
 *   - graduation_signals: per-tier "ready to enable auto-publish" flag
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days = Math.min(90, Math.max(7, parseInt(searchParams.get('days') ?? '30', 10)))
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  // 1. Feedback summary by bucket
  const { data: feedback } = await db
    .from('brief_review_feedback')
    .select('reason_classified, severity, section_label, brief_id, created_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('created_at', sinceIso)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fbRows = (feedback ?? []) as any[]

  const byBucket: Record<string, { total: number; minor: number; major: number; critical: number }> = {}
  let unclassified = 0
  for (const r of fbRows) {
    const b = r.reason_classified ? String(r.reason_classified) : 'unclassified'
    if (b === 'unclassified') unclassified++
    const cur = byBucket[b] ?? { total: 0, minor: 0, major: 0, critical: 0 }
    cur.total++
    if      (r.severity === 'critical') cur.critical++
    else if (r.severity === 'major')    cur.major++
    else                                 cur.minor++
    byBucket[b] = cur
  }

  // 2. Pending proposals from review_feedback source
  const { data: proposals } = await db
    .from('kb_rule_proposals')
    .select('id, title, rule_text, pattern_kind, confidence, source_brief_ids, created_at, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('source', 'review_feedback')
    .eq('status', 'pending')
    .order('confidence', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50)

  // 3. Threshold recommendations
  const thresholdRecs = await recommendAutopublishThresholds(db, ownerId, siteSlug, days)

  // 4. Graduation signals — per-tier, is autopublish ready to enable?
  // Heuristic: enable when ≥10 approved briefs in window AND ≥95% would pass current threshold
  const graduationSignals = thresholdRecs.map(rec => ({
    tier_level:  rec.tier_level,
    ready:       rec.approved_count >= 10 && rec.pass_pct_at_current >= 95,
    rationale:   rec.approved_count >= 10 && rec.pass_pct_at_current >= 95
      ? `${rec.approved_count} approved briefs, ${rec.pass_pct_at_current}% pass at current threshold — safe to enable auto-publish`
      : rec.approved_count < 10
        ? `Only ${rec.approved_count} approved briefs in ${days}d. Need ≥10 for signal.`
        : `Only ${rec.pass_pct_at_current}% of approved briefs pass current threshold — adjust thresholds first.`,
  }))

  return NextResponse.json({
    window_days:               days,
    feedback_summary:          {
      total_rows:    fbRows.length,
      unclassified,
      by_bucket:     byBucket,
    },
    pending_proposals:         proposals ?? [],
    threshold_recommendations: thresholdRecs,
    graduation_signals:        graduationSignals,
  })
}
