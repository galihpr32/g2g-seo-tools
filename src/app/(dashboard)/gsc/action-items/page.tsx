import { createClient } from '@/lib/supabase/server'
import { ActionItemsTable, type ActionItem, type BriefStatus } from './ActionItemsTable'

export const dynamic = 'force-dynamic'

export default async function ActionItemsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: conn } = user
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', user.id).single()
    : { data: null }

  const siteUrl = conn?.site_url

  const { data: items } = siteUrl
    ? await supabase
        .from('seo_action_items')
        .select('*')
        .eq('site_url', siteUrl)
        .order('created_at', { ascending: false })
    : { data: [] }

  // Load brief status for each action item
  const itemIds = (items ?? []).map(i => i.id)
  const { data: briefs } = itemIds.length
    ? await supabase
        .from('seo_content_briefs')
        .select('action_item_id, status, brief_type')
        .in('action_item_id', itemIds)
    : { data: [] }

  // Build a map: action_item_id → { status, brief_type }
  const briefStatuses: Record<string, BriefStatus> = {}
  for (const b of briefs ?? []) {
    // Only store the most recent brief per action item (order is not guaranteed,
    // but for now take last one; page.tsx query doesn't order so just overwrite)
    briefStatuses[b.action_item_id] = {
      status: b.status as BriefStatus['status'],
      brief_type: b.brief_type as BriefStatus['brief_type'],
    }
  }

  const pendingCount    = items?.filter(i => i.status === 'pending').length    ?? 0
  const inProgressCount = items?.filter(i => i.status === 'in_progress').length ?? 0
  const briefCount      = Object.keys(briefStatuses).length

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
          items={(items ?? []) as ActionItem[]}
          briefStatuses={briefStatuses}
          currentUserEmail={user?.email ?? ''}
        />
      )}
    </div>
  )
}
