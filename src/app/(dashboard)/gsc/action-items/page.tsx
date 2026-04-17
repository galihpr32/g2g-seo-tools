import { createClient } from '@/lib/supabase/server'
import { ActionItemsTable, type ActionItem, type BriefSummary } from './ActionItemsTable'

export const dynamic = 'force-dynamic'

export default async function ActionItemsPage({
  searchParams,
}: {
  searchParams: { page?: string; limit?: string; from?: string; to?: string }
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: conn } = user
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', user.id).single()
    : { data: null }

  const siteUrl = conn?.site_url

  // ── Pagination + date params ──────────────────────────────────────────────
  const limit  = Math.min(Math.max(parseInt(searchParams.limit ?? '20'), 1), 100)
  const page   = Math.max(parseInt(searchParams.page ?? '1'), 1)
  const offset = (page - 1) * limit
  const from   = searchParams.from ?? null   // ISO date string, e.g. "2025-01-01"
  const to     = searchParams.to   ?? null   // ISO date string, e.g. "2025-03-31"

  // ── Query with pagination + optional date range ───────────────────────────
  let totalCount = 0
  let items: ActionItem[] = []

  if (siteUrl) {
    let query = supabase
      .from('seo_action_items')
      .select('*', { count: 'exact' })
      .eq('site_url', siteUrl)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (from) query = query.gte('snapshot_date', from)
    if (to)   query = query.lte('snapshot_date', to)

    const { data, count } = await query
    items      = (data ?? []) as ActionItem[]
    totalCount = count ?? 0
  }

  const totalPages = Math.ceil(totalCount / limit)

  // ── Load extended brief data for this page's items ────────────────────────
  const itemIds = items.map(i => i.id)
  const { data: briefs } = itemIds.length
    ? await supabase
        .from('seo_content_briefs')
        .select('id, action_item_id, status, brief_type, content_ideas, content_draft')
        .in('action_item_id', itemIds)
    : { data: [] }

  const briefSummaries: Record<string, BriefSummary> = {}
  for (const b of briefs ?? []) {
    const ideas = (b.content_ideas ?? []) as Array<{ content_type: string; draft?: string }>
    briefSummaries[b.action_item_id] = {
      brief_id: b.id,
      status:     b.status     as BriefSummary['status'],
      brief_type: b.brief_type as BriefSummary['brief_type'],
      blog_count:          ideas.filter(i => i.content_type === 'blog_post').length,
      forum_count:         ideas.filter(i => i.content_type === 'forum').length,
      social_count:        ideas.filter(i => i.content_type === 'social').length,
      draft_count:         ideas.filter(i => i.draft).length,
      content_draft_words: b.content_draft
        ? (b.content_draft as string).split(/\s+/).filter(Boolean).length
        : 0,
    }
  }

  const pendingCount    = items.filter(i => i.status === 'pending').length
  const inProgressCount = items.filter(i => i.status === 'in_progress').length
  const briefCount      = Object.keys(briefSummaries).length

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🎯 Action Items</h1>
          <p className="text-gray-400 text-sm mt-1">
            Pages assigned for optimization from Ranking Drop alerts
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {pendingCount > 0 && (
            <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-full">
              {pendingCount} pending
            </span>
          )}
          {inProgressCount > 0 && (
            <span className="text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 px-3 py-1.5 rounded-full">
              {inProgressCount} in progress
            </span>
          )}
          {briefCount > 0 && (
            <span className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-full">
              {briefCount} brief{briefCount > 1 ? 's' : ''} generated
            </span>
          )}
          <a
            href="/gsc/ranking-drop"
            className="text-xs text-gray-400 bg-gray-800 hover:bg-gray-700 px-3 py-1.5 rounded-full transition"
          >
            ← Ranking Drop
          </a>
        </div>
      </div>

      {!conn ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections to connect Google Search Console.</p>
        </div>
      ) : (
        <ActionItemsTable
          items={items}
          briefSummaries={briefSummaries}
          currentUserEmail={user?.email ?? ''}
          pagination={{
            page,
            limit,
            total: totalCount,
            totalPages,
            from: from ?? '',
            to:   to   ?? '',
          }}
        />
      )}
    </div>
  )
}
