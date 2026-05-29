import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 20

/**
 * GET /api/reports/mimir-learning?window=30
 *
 * Sprint MIMIR.LEARN — aggregates everything the dashboard needs in one
 * round trip. Sections:
 *   1. Top metrics:   totalMemories, addedInWindow, dormantCount, activeRate
 *   2. Coverage map:  count of memories per (category × scope)
 *   3. Knowledge gaps: top categories + top topics from retrieval misses
 *   4. Recent additions: last N memories
 *   5. Dormant memories: not accessed in window
 *   6. Source distribution: count by metadata.source
 *
 * Query param `window` (default 30d) drives the recent / dormant filter.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const url = new URL(req.url)
  const window = Math.min(365, Math.max(1, Number(url.searchParams.get('window') ?? 30)))
  const sinceIso = new Date(Date.now() - window * 86_400_000).toISOString()

  // ── 1. Totals + recent + dormant ──────────────────────────────────────
  const { count: totalCount } = await db
    .from('mimir_memories')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', ownerId)
    .eq('archived', false)

  const { data: recent } = await db
    .from('mimir_memories')
    .select('id, content, scope, site_slug, importance, tags, updated_at, created_at')
    .eq('owner_user_id', ownerId)
    .eq('archived', false)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(30)

  const { data: dormant } = await db
    .from('mimir_memories')
    .select('id, content, scope, site_slug, importance, tags, updated_at, last_used_at')
    .eq('owner_user_id', ownerId)
    .eq('archived', false)
    .lt('updated_at', sinceIso)
    .order('updated_at', { ascending: true })
    .limit(30)

  // Active rate: % of memories used in last `window` days (proxy: updated_at)
  const { count: activeCount } = await db
    .from('mimir_memories')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', ownerId)
    .eq('archived', false)
    .gte('updated_at', sinceIso)

  // ── 2. Coverage map: count by (scope × site_slug × tag) ──────────────
  // We aggregate client-side from the tags array; cheap for <1k rows.
  const { data: coverageRows } = await db
    .from('mimir_memories')
    .select('scope, site_slug, tags')
    .eq('owner_user_id', ownerId)
    .eq('archived', false)
    .limit(2000)

  const coverage = new Map<string, number>()
  for (const r of coverageRows ?? []) {
    const key = `${r.scope}|${r.site_slug ?? '_'}`
    coverage.set(key, (coverage.get(key) ?? 0) + 1)
  }

  // ── 3. Knowledge gaps from retrieval misses ──────────────────────────
  // Top categories (uses Haiku-classified column when populated)
  const { data: missCategories } = await db
    .from('mimir_retrieval_misses')
    .select('category')
    .eq('owner_user_id', ownerId)
    .gte('created_at', sinceIso)
    .not('category', 'is', null)
    .limit(2000)

  const categoryGapMap = new Map<string, number>()
  for (const r of missCategories ?? []) {
    if (r.category) categoryGapMap.set(r.category, (categoryGapMap.get(r.category) ?? 0) + 1)
  }
  const top_category_gaps = Array.from(categoryGapMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // Top topics (raw query strings, simple count)
  const { data: missTopics } = await db
    .from('mimir_retrieval_misses')
    .select('topic, query, created_at')
    .eq('owner_user_id', ownerId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(2000)

  const topicGapMap = new Map<string, { count: number; last_asked: string }>()
  for (const r of missTopics ?? []) {
    const key = r.topic ?? (r.query as string).slice(0, 40)
    const existing = topicGapMap.get(key)
    if (existing) {
      existing.count++
    } else {
      topicGapMap.set(key, { count: 1, last_asked: r.created_at as string })
    }
  }
  const top_topic_gaps = Array.from(topicGapMap.entries())
    .map(([topic, x]) => ({ topic, count: x.count, last_asked: x.last_asked }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)

  // ── 4. Source distribution ────────────────────────────────────────────
  // Most memories have metadata.source key. We aggregate from the tags as
  // a fallback indicator (auto-seed vs chat-extracted vs manual).
  const sourceMap = new Map<string, number>()
  for (const r of coverageRows ?? []) {
    const tags = (r.tags ?? []) as string[]
    let src = 'manual'
    if (tags.includes('auto-seed') || tags.includes('autoseed')) src = 'auto-seed'
    else if (tags.includes('chat-extracted') || tags.includes('chat'))  src = 'chat'
    sourceMap.set(src, (sourceMap.get(src) ?? 0) + 1)
  }
  const source_distribution = Array.from(sourceMap.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)

  return NextResponse.json({
    window_days: window,
    totals: {
      total_memories:    totalCount  ?? 0,
      added_in_window:   recent?.length ?? 0,
      dormant_count:     dormant?.length ?? 0,
      active_in_window:  activeCount ?? 0,
      utilization_pct:   totalCount && totalCount > 0
        ? Math.round(((activeCount ?? 0) / totalCount) * 100)
        : 0,
    },
    coverage: Array.from(coverage.entries()).map(([key, count]) => {
      const [scope, site] = key.split('|')
      return { scope, site_slug: site === '_' ? null : site, count }
    }).sort((a, b) => b.count - a.count),
    knowledge_gaps: {
      top_categories: top_category_gaps,
      top_topics:     top_topic_gaps,
      total_misses:   missTopics?.length ?? 0,
      unclassified:   (missTopics ?? []).filter(r => !r.topic).length,
    },
    recent_additions: recent ?? [],
    dormant_memories: dormant ?? [],
    source_distribution,
  })
}
