import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET /api/agents/insights
 *
 * Aggregates everything needed for the /command-center/insights page:
 *   - Approval rate per agent (last 30d)
 *   - Tyr score distribution (last 30d) with mean / median / borderline count
 *   - Topic coverage (per active topic: published vs total clusters)
 *   - Pending tune_config + coverage_review actions (Vor + Saga suggestions)
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  // 1. Approval rates per agent
  const { data: actions } = await db
    .from('agent_actions')
    .select('agent_key, status, priority')
    .eq('owner_user_id', ownerId)
    .gte('created_at', sinceIso)

  const approvalByAgent: Record<string, { total: number; approved: number; rejected: number; pending: number; executed: number }> = {}
  for (const a of actions ?? []) {
    const slot = approvalByAgent[a.agent_key] ?? (approvalByAgent[a.agent_key] = { total: 0, approved: 0, rejected: 0, pending: 0, executed: 0 })
    slot.total++
    if (a.status === 'approved') slot.approved++
    else if (a.status === 'rejected') slot.rejected++
    else if (a.status === 'pending')  slot.pending++
    else if (a.status === 'executed') slot.executed++
  }

  // 2. Tyr score distribution
  const { data: tyrBriefs } = await db
    .from('seo_content_briefs')
    .select('tyr_score, tyr_status')
    .eq('owner_user_id', ownerId)
    .gte('tyr_reviewed_at', sinceIso)
    .not('tyr_score', 'is', null)

  let mean = 0, median = 0, count = 0, borderline = 0, failed = 0, reviewed = 0
  if (tyrBriefs?.length) {
    count = tyrBriefs.length
    const scores = (tyrBriefs as Array<{ tyr_score: number; tyr_status: string }>).map(b => b.tyr_score).sort((a, b) => a - b)
    mean   = Math.round(scores.reduce((s, v) => s + v, 0) / count)
    median = scores[Math.floor(count / 2)]
    for (const b of tyrBriefs as Array<{ tyr_score: number; tyr_status: string }>) {
      if (b.tyr_status === 'borderline') borderline++
      else if (b.tyr_status === 'failed') failed++
      else if (b.tyr_status === 'reviewed') reviewed++
    }
  }

  // 3. Topic coverage
  const { data: maps } = await db
    .from('keyword_maps')
    .select('id, topic, status, last_cluster_activity_at')
    .eq('owner_user_id', ownerId)
    .neq('status', 'archived')
    .order('last_cluster_activity_at', { ascending: false, nullsFirst: false })

  const { data: clusters } = await db
    .from('keyword_map_clusters')
    .select('id, map_id, status')
    .eq('owner_user_id', ownerId)
    .neq('status', 'archived')

  const clusterByMap = new Map<string, Array<{ id: string; status: string }>>()
  for (const c of clusters ?? []) {
    const arr = clusterByMap.get(c.map_id as string) ?? []
    arr.push({ id: c.id as string, status: c.status as string })
    clusterByMap.set(c.map_id as string, arr)
  }

  const topics = (maps ?? []).map(m => {
    const cs = clusterByMap.get(m.id as string) ?? []
    const published = cs.filter(c => c.status === 'published' || c.status === 'tracking').length
    return {
      id:           m.id as string,
      topic:        m.topic as string,
      status:       m.status as string,
      lastActivity: m.last_cluster_activity_at as string | null,
      total:        cs.length,
      published,
      coveragePct:  cs.length > 0 ? Math.round((published / cs.length) * 100) : 0,
    }
  })

  // 4. Pending tune_config + coverage_review (Vor + Saga proposals)
  const { data: pendingMeta } = await db
    .from('agent_actions')
    .select('id, agent_key, action_type, title, description, priority, created_at')
    .eq('owner_user_id', ownerId)
    .in('action_type', ['tune_config', 'coverage_review', 'archive_cluster', 'create_topic_map', 'add_to_cluster'])
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20)

  return NextResponse.json({
    windowDays: 30,
    approvalByAgent,
    tyr: {
      reviewedCount: count,
      meanScore:     mean,
      medianScore:   median,
      promoted:      reviewed,
      borderline,
      failed,
    },
    topics,
    pendingMeta: pendingMeta ?? [],
  })
}
