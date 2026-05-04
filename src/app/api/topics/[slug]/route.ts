import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { costForCall } from '@/lib/anthropic-pricing'

export const maxDuration = 30

/**
 * GET /api/topics/[slug]
 *
 * Centralized topic lifecycle view — aggregates data across pipeline,
 * briefs, brief_outcomes, outreach, team activity, agent runs, AI visibility.
 * Powers /content/topics/[slug] page.
 *
 * Match strategy: by topic_slug exact match OR by topic ILIKE pattern.
 * Returns a unified payload — frontend renders sections based on what's present.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  const decodedSlug = decodeURIComponent(slug)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // ── 1. Find matching opportunities (by topic_slug or topic) ─────────────
  const { data: oppsBySlug } = await db
    .from('seo_opportunities')
    .select('id, topic, topic_slug, target_url, status, output_type, total_sv, signal_count, created_at, updated_at, brief_id, approved_by, approved_at, dismissed_by, dismissed_at, heimdall_signals, loki_signals, odin_signals')
    .eq('owner_user_id', ownerId)
    .eq('topic_slug', decodedSlug)
    .limit(20)

  // Fallback: ilike on topic name (slug → readable variant)
  let opps = oppsBySlug ?? []
  if (opps.length === 0) {
    const readable = decodedSlug.replace(/-/g, ' ')
    const { data: oppsByName } = await db
      .from('seo_opportunities')
      .select('id, topic, topic_slug, target_url, status, output_type, total_sv, signal_count, created_at, updated_at, brief_id, approved_by, approved_at, dismissed_by, dismissed_at, heimdall_signals, loki_signals, odin_signals')
      .eq('owner_user_id', ownerId)
      .ilike('topic', `%${readable}%`)
      .limit(20)
    opps = oppsByName ?? []
  }

  if (opps.length === 0) {
    return NextResponse.json({ error: 'topic not found', slug: decodedSlug }, { status: 404 })
  }

  const oppIds = opps.map(o => o.id)
  const oppTopics = opps.map(o => o.topic).filter(Boolean) as string[]
  const primaryOpp = opps[0]

  // ── 2. Briefs linked to these opps (via brief_id OR notes tag) ──────────
  const { data: allBriefs } = await db
    .from('seo_content_briefs')
    .select('id, brief_type, status, tyr_status, tyr_score, claude_review_status, claude_review_score, primary_keyword, page, target_publish_date, published_at, published_by, assigned_to, assigned_at, created_at, updated_at, notes')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: true })
    .limit(200)

  const briefs = (allBriefs ?? []).filter(b => {
    // Direct link via opp.brief_id
    if (opps.some(o => o.brief_id === b.id)) return true
    // Notes tag match
    if (b.notes && oppIds.some(id => b.notes!.includes(`(${id})`))) return true
    return false
  })

  // ── 3. Brief outcomes (Vor ranking impact) ──────────────────────────────
  const briefIds = briefs.map(b => b.id)
  let outcomes: Array<Record<string, unknown>> = []
  if (briefIds.length > 0) {
    const { data: outRows } = await db
      .from('brief_outcomes')
      .select('brief_id, checkpoint, position_before, position_after, clicks_before, clicks_after, snapshot_date, published_at')
      .in('brief_id', briefIds)
      .eq('owner_user_id', ownerId)
      .order('checkpoint', { ascending: true })
    outcomes = outRows ?? []
  }

  // ── 4. Outreach prospects matching this topic ───────────────────────────
  const { data: prospects } = await db
    .from('outreach_prospects')
    .select('id, domain, source_keyword, status, contact_name, anchor_text, claimed_by, claimed_at, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .in('source_keyword', oppTopics)
    .order('created_at', { ascending: false })
    .limit(40)

  // ── 5. Cluster info: is this topic in any keyword_map? ──────────────────
  const { data: clusterRows } = await db
    .from('keyword_map_clusters')
    .select('id, map_id, keyword, cluster_group, is_pillar, status, search_volume, difficulty')
    .eq('owner_user_id', ownerId)
    .in('keyword', oppTopics)
    .limit(30)

  const mapIds = Array.from(new Set((clusterRows ?? []).map(c => c.map_id)))
  let maps: Array<Record<string, unknown>> = []
  if (mapIds.length > 0) {
    const { data: mapRows } = await db
      .from('keyword_maps')
      .select('id, topic, topic_slug, status, pillar_keyword, market')
      .in('id', mapIds)
      .eq('owner_user_id', ownerId)
    maps = mapRows ?? []
  }

  // ── 6. Agent runs touching this topic (last 30 days) ────────────────────
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString()
  const { data: agentRuns } = await db
    .from('agent_runs')
    .select('id, agent_key, status, summary, started_at, finished_at')
    .eq('owner_user_id', ownerId)
    .gte('started_at', thirtyDaysAgo)
    .order('started_at', { ascending: false })
    .limit(40)

  // ── 7. AI visibility (Frey snapshots — only if deployed) ────────────────
  const { data: aiSnapshots } = await db
    .from('ai_visibility_snapshots')
    .select('week_starting, visibility_score, mention_rate, avg_position, avg_sentiment, top_competitor, prompt_coverage')
    .eq('owner_user_id', ownerId)
    .eq('topic_slug', primaryOpp.topic_slug ?? decodedSlug)
    .order('week_starting', { ascending: true })
    .limit(12)

  // ── 8. Resolve actor emails (workspace_members + owner self) ────────────
  const actorIds = new Set<string>()
  for (const o of opps) {
    if (o.approved_by)  actorIds.add(o.approved_by)
    if (o.dismissed_by) actorIds.add(o.dismissed_by)
  }
  for (const b of briefs) {
    if (b.published_by) actorIds.add(b.published_by)
    if (b.assigned_to)  actorIds.add(b.assigned_to)
  }
  for (const p of prospects ?? []) {
    if (p.claimed_by) actorIds.add(p.claimed_by)
  }

  const actorMap: Record<string, string> = {}
  if (actorIds.size > 0) {
    const { data: members } = await db
      .from('workspace_members')
      .select('member_user_id, member_email')
      .eq('owner_user_id', ownerId)
      .in('member_user_id', Array.from(actorIds))
    for (const m of (members ?? []) as Array<{ member_user_id: string; member_email: string }>) {
      if (m.member_user_id) actorMap[m.member_user_id] = m.member_email
    }
    // Owner self via auth.users
    const missing = Array.from(actorIds).filter(id => !actorMap[id])
    for (const id of missing) {
      try {
        const { data: au } = await db.auth.admin.getUserById(id)
        if (au?.user?.email) actorMap[id] = au.user.email
      } catch { /* silent */ }
    }
  }

  // ── 9. Compute lifecycle stage summary ──────────────────────────────────
  const publishedBriefs = briefs.filter(b => b.status === 'published')
  const reviewedBriefs  = briefs.filter(b => b.status === 'reviewed' || b.tyr_status === 'reviewed')

  // ── 8b. Cost per topic — sum Claude usage across briefs linked to this topic
  // Aggregates api_usage_logs WHERE metadata->>'brief_id' IN (...) and converts
  // input/output tokens to USD via anthropic-pricing.ts.
  // Forward-only: rows logged before brief_id was added in metadata won't show.
  let totalCostUsd     = 0
  let costCallCount    = 0
  const costByEndpoint: Record<string, { calls: number; usd: number }> = {}

  if (briefIds.length > 0) {
    // Supabase doesn't have a great "metadata->>X IN (array)" so we fetch by
    // narrow time window + filter in memory. Briefs are typically <30 days old.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString()
    const { data: usageRows } = await db
      .from('api_usage_logs')
      .select('api_name, endpoint, metadata, created_at')
      .eq('owner_user_id', ownerId)
      .eq('api_name', 'claude')
      .gte('created_at', ninetyDaysAgo)
      .limit(2000)

    for (const r of (usageRows ?? []) as Array<{ api_name: string; endpoint: string; metadata: Record<string, unknown> }>) {
      const briefIdInMeta = r.metadata?.brief_id as string | undefined
      if (!briefIdInMeta || !briefIds.includes(briefIdInMeta)) continue

      const model    = String(r.metadata?.model ?? 'claude-haiku-4-5')
      const inTok    = Number(r.metadata?.input_tokens  ?? 0)
      const outTok   = Number(r.metadata?.output_tokens ?? 0)
      const usd      = costForCall(model, inTok, outTok)

      totalCostUsd += usd
      costCallCount++
      const key = r.endpoint || 'unknown'
      if (!costByEndpoint[key]) costByEndpoint[key] = { calls: 0, usd: 0 }
      costByEndpoint[key].calls++
      costByEndpoint[key].usd += usd
    }
  }

  // ── 8c. Time-to-content metric ──────────────────────────────────────────
  // Days from oldest opp.created_at to first publish event (brief.published_at
  // or opportunity.status='published'). Null if not yet published.
  const oldestOppCreated = opps.reduce<string | null>((min, o) => {
    if (!min) return o.created_at
    return new Date(o.created_at) < new Date(min) ? o.created_at : min
  }, null)

  const firstPublishedAt = briefs
    .filter(b => b.status === 'published' && b.published_at)
    .map(b => b.published_at!)
    .sort()[0] ?? null

  const timeToContentDays = (oldestOppCreated && firstPublishedAt)
    ? Math.max(0, Math.round((new Date(firstPublishedAt).getTime() - new Date(oldestOppCreated).getTime()) / 86400000))
    : null

  const lifecycle = {
    detected:   opps.length > 0,
    aggregated: !!primaryOpp.topic_slug,
    triaged:    opps.some(o => ['brief_queued', 'brief_ready', 'published'].includes(o.status)),
    has_brief:  briefs.length > 0,
    in_review:  reviewedBriefs.length > 0 && publishedBriefs.length === 0,
    published:  publishedBriefs.length > 0,
    has_outreach: (prospects ?? []).length > 0,
    has_outcomes: outcomes.length > 0,
  }

  return NextResponse.json({
    slug:         decodedSlug,
    topic:        primaryOpp.topic,
    opps,
    primary_opp:  primaryOpp,
    briefs,
    outcomes,
    prospects:    prospects ?? [],
    clusters:     clusterRows ?? [],
    maps,
    agent_runs:   agentRuns ?? [],
    ai_snapshots: aiSnapshots ?? [],
    actor_map:    actorMap,
    lifecycle,
    metrics: {
      time_to_content_days: timeToContentDays,
      first_published_at:   firstPublishedAt,
      oldest_detected_at:   oldestOppCreated,
      cost_usd_total:       Number(totalCostUsd.toFixed(4)),
      cost_call_count:      costCallCount,
      cost_by_endpoint:     Object.entries(costByEndpoint)
        .map(([endpoint, v]) => ({ endpoint, calls: v.calls, usd: Number(v.usd.toFixed(4)) }))
        .sort((a, b) => b.usd - a.usd),
    },
  })
}
