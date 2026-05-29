import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

/**
 * GET /api/forseti/stats
 *
 * Compact stats payload used by:
 *   • /dashboard Community Response widget (Sprint FORSETI.DASH.WIDGET)
 *   • Friday KPI digest (Sprint FORSETI.DIGEST)
 *
 * Returns last-7d numbers scoped to (owner × site).
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const stats = await computeForsetiStats(db, ownerId, siteSlug, 7)
  return NextResponse.json(stats)
}

export interface ForsetiStats {
  spotted_this_week:     number
  responded:             number
  response_rate_pct:     number
  sev4plus_pending:      number
  avg_response_time_h:   number | null
  by_category:           Array<{ category: string; count: number }>
  top_assignee_count:    number      // 0 if no assignments yet
  resolved_this_week:    number
  escalated_this_week:   number
}

export async function computeForsetiStats(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>,
  ownerId:   string,
  siteSlug:  string,
  windowDays: number,
): Promise<ForsetiStats> {
  const cutoffIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  // 7d window threads
  const { data: rows } = await db
    .from('forseti_threads')
    .select('id, status, assignee_user_id, auto_category, manual_category_override, auto_severity, manual_severity_override, first_seen_at, responded_at, resolved_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .gte('first_seen_at', cutoffIso)
    .limit(2000)

  // Sev-4+ pending (across all time, not just window)
  const { data: pendingRows } = await db
    .from('forseti_threads')
    .select('id, auto_severity, manual_severity_override')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .in('status', ['spotted', 'drafted'])
    .limit(500)

  type Row = {
    status:                   string
    assignee_user_id:         string | null
    auto_category:            string
    manual_category_override: string | null
    auto_severity:            number
    manual_severity_override: number | null
    first_seen_at:            string
    responded_at:             string | null
    resolved_at:              string | null
  }

  const safe = (rows ?? []) as Row[]
  const spotted = safe.length
  const responded = safe.filter(r => r.responded_at).length
  const respRate = spotted > 0 ? Math.round((responded / spotted) * 100) : 0

  const avgRespMs = (() => {
    const samples = safe
      .filter(r => r.responded_at)
      .map(r => new Date(r.responded_at!).getTime() - new Date(r.first_seen_at).getTime())
    if (samples.length === 0) return null
    return samples.reduce((s, n) => s + n, 0) / samples.length
  })()

  const catCounts = new Map<string, number>()
  for (const r of safe) {
    const cat = r.manual_category_override ?? r.auto_category
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1)
  }
  const by_category = Array.from(catCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  const assigneeCounts = new Map<string, number>()
  for (const r of safe) {
    if (r.assignee_user_id) assigneeCounts.set(r.assignee_user_id, (assigneeCounts.get(r.assignee_user_id) ?? 0) + 1)
  }
  const top_assignee_count = assigneeCounts.size === 0
    ? 0
    : Math.max(...assigneeCounts.values())

  const sev4Plus = (pendingRows ?? []).filter(r => {
    const sev = (r.manual_severity_override ?? r.auto_severity) as number
    return sev >= 4
  }).length

  return {
    spotted_this_week:   spotted,
    responded,
    response_rate_pct:   respRate,
    sev4plus_pending:    sev4Plus,
    avg_response_time_h: avgRespMs == null ? null : Math.round((avgRespMs / 3600_000) * 10) / 10,
    by_category,
    top_assignee_count,
    resolved_this_week:  safe.filter(r => r.status === 'resolved'  && r.resolved_at && new Date(r.resolved_at).getTime() >= Date.now() - windowDays * 86400_000).length,
    escalated_this_week: safe.filter(r => r.status === 'escalated' && r.resolved_at && new Date(r.resolved_at).getTime() >= Date.now() - windowDays * 86400_000).length,
  }
}
