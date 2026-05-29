import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import OpportunitiesClient from './OpportunitiesClient'
import MimirPanel from '@/components/agents/MimirPanel'

export default async function OpportunitiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Load initial data server-side (no dismissed, sorted by recency)
  const { data: opportunities } = await db
    .from('seo_opportunities')
    .select(`
      id, topic, topic_slug, target_url, status, output_type,
      signal_count, total_sv, created_at, updated_at, last_signal_at,
      brief_id, tyr_score, tyr_status,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .neq('status', 'dismissed')
    .order('updated_at', { ascending: false })
    .limit(200)

  // ── Dedup detection ──────────────────────────────────────────────────────
  // For each opportunity, look up past briefs / action items with the same
  // topic_slug or matching primary_keyword in the last 90 days. Surface as
  // "previously worked on" badge — prevents the user from re-queuing the
  // same brief. This was a specific Galih ask in the deep-dive feedback.
  const since90d = new Date(Date.now() - 90 * 86400_000).toISOString()
  const slugs    = Array.from(new Set((opportunities ?? []).map(o => o.topic_slug).filter(Boolean)))

  const { data: pastBriefs } = slugs.length > 0
    ? await db
        .from('seo_content_briefs')
        .select('id, primary_keyword, page, status, published_at, created_at, content_outline')
        .eq('owner_user_id', effectiveOwnerId)
        .gte('created_at', since90d)
    : { data: [] }

  const { data: pastActions } = await db
    .from('seo_action_items')
    .select('id, page, action_type, status, created_at, completed_at')
    .eq('owner_user_id', effectiveOwnerId)
    .gte('created_at', since90d)
    .limit(500)

  // Index past work by topic-slug-ish (lowercase keyword match)
  type PastWork = { id: string; kind: 'brief' | 'action'; status: string; created_at: string; published_at?: string | null; primary_keyword?: string | null; page?: string | null }
  const pastWorkByTopic = new Map<string, PastWork[]>()
  function tokenize(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }
  for (const b of pastBriefs ?? []) {
    const key = tokenize(String(b.primary_keyword ?? ''))
    if (!key) continue
    const arr = pastWorkByTopic.get(key) ?? []
    arr.push({
      id: String(b.id),
      kind: 'brief',
      status: String(b.status ?? '?'),
      created_at: String(b.created_at),
      published_at: b.published_at as string | null,
      primary_keyword: b.primary_keyword as string | null,
      page: b.page as string | null,
    })
    pastWorkByTopic.set(key, arr)
  }
  for (const a of pastActions ?? []) {
    const key = tokenize(String(a.page ?? ''))
    if (!key) continue
    const arr = pastWorkByTopic.get(key) ?? []
    arr.push({
      id: String(a.id),
      kind: 'action',
      status: String(a.status ?? '?'),
      created_at: String(a.created_at),
      page: a.page as string | null,
    })
    pastWorkByTopic.set(key, arr)
  }

  // ── Cluster-aware sibling detection ──────────────────────────────────────
  // Sprint 8.2: detect when multiple opportunities point to the same Saga
  // sub-product cluster. Surfaces "3 sibling opps in WoW Gold cluster" so
  // Specialist 1 can batch-process related opps.
  const targetUrls = Array.from(new Set((opportunities ?? []).map(o => o.target_url).filter(Boolean) as string[]))
  const { data: clusterPages } = targetUrls.length > 0
    ? await db
        .from('cluster_pages')
        .select('cluster_id, page_url')
        .eq('owner_user_id', effectiveOwnerId)
        .in('page_url', targetUrls)
    : { data: [] }

  const urlToClusterId = new Map<string, string>()
  for (const cp of (clusterPages ?? []) as Array<{ cluster_id: string; page_url: string }>) {
    urlToClusterId.set(cp.page_url, cp.cluster_id)
  }

  // Count opportunities per cluster_id
  const clusterCounts = new Map<string, number>()
  for (const o of opportunities ?? []) {
    const cid = o.target_url ? urlToClusterId.get(o.target_url) : null
    if (!cid) continue
    clusterCounts.set(cid, (clusterCounts.get(cid) ?? 0) + 1)
  }

  // Attach `pastWork` array to each opportunity. We match on topic_slug.
  const enrichedOpportunities = (opportunities ?? []).map(o => {
    const slugKey = tokenize(String(o.topic_slug ?? ''))
    const topicKey = tokenize(String(o.topic ?? ''))
    const pastWork: PastWork[] = []
    for (const k of [slugKey, topicKey].filter(Boolean)) {
      const matches = pastWorkByTopic.get(k) ?? []
      for (const m of matches) {
        if (!pastWork.find(p => p.id === m.id && p.kind === m.kind)) pastWork.push(m)
      }
    }
    // Also fuzzy: substring match on primary_keyword vs topic
    if (pastWork.length === 0 && topicKey.length >= 4) {
      for (const [key, matches] of pastWorkByTopic.entries()) {
        if (key.includes(topicKey) || topicKey.includes(key)) {
          for (const m of matches) {
            if (!pastWork.find(p => p.id === m.id && p.kind === m.kind)) pastWork.push(m)
          }
        }
      }
    }
    const cid = o.target_url ? urlToClusterId.get(o.target_url) : null
    const clusterSiblings = cid ? Math.max(0, (clusterCounts.get(cid) ?? 0) - 1) : 0
    return { ...o, pastWork: pastWork.slice(0, 5), cluster_siblings: clusterSiblings }
  })

  // Count stats for header
  const allStatuses = enrichedOpportunities.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              🎯 Opportunities
            </h1>
            <p className="text-gray-400 mt-2">
              Signals from Detection agents grouped by topic. Pick an opportunity, choose an output type, and queue a brief or outreach action.
            </p>
          </div>
          <div className="flex items-center gap-2 mt-1 flex-shrink-0">
            <MimirPanel
              pageContext={{ kind: 'opportunities' }}
              trigger="🪶 Ask Mimir"
            />
            <a
              href="/command-center"
              className="text-sm text-gray-500 hover:text-gray-300 transition whitespace-nowrap"
            >
              ← Command Center
            </a>
          </div>
        </div>

        {/* Pipeline hint */}
        <div className="mt-4 flex items-center gap-2 text-xs text-gray-500">
          <span className="px-2 py-1 rounded bg-blue-950/40 border border-blue-800/30 text-blue-400">Detection</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-indigo-950/40 border border-indigo-800/30 text-indigo-400 font-medium">Opportunities ← you are here</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-green-950/40 border border-green-800/30 text-green-400">Brief / Outreach</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-amber-950/40 border border-amber-800/30 text-amber-400">Tyr Review</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-purple-950/40 border border-purple-800/30 text-purple-400">Published</span>
        </div>
      </div>

      <OpportunitiesClient
        initialOpportunities={enrichedOpportunities}
        statusCounts={allStatuses}
      />
    </div>
  )
}
