import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// How many days in-progress before an item is considered stale
const STALE_DAYS = 7

type ActionItem = {
  id: string
  page: string
  action_type: 'on_page' | 'off_page'
  status: string
  notes: string | null
  assigned_to: string | null
  created_at: string
  snapshot_date: string
}

function pagePath(url: string) {
  try { return new URL(url).pathname } catch { return url }
}

function daysAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

export default async function NotificationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const effectiveOwnerId = user ? await getEffectiveOwnerId(supabase, user.id) : null
  const { data: conn } = effectiveOwnerId
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', effectiveOwnerId).single()
    : { data: null }

  const siteUrl = conn?.site_url

  let staleItems: ActionItem[]   = []
  let unassignedItems: ActionItem[] = []

  if (siteUrl) {
    const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const [staleRes, unassignedRes] = await Promise.all([
      // Stale: in_progress AND created more than STALE_DAYS ago
      supabase
        .from('seo_action_items')
        .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
        .eq('site_url', siteUrl)
        .eq('status', 'in_progress')
        .lt('created_at', staleThreshold)
        .order('created_at', { ascending: true }),

      // Unassigned: in_progress AND no assignee
      supabase
        .from('seo_action_items')
        .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
        .eq('site_url', siteUrl)
        .eq('status', 'in_progress')
        .is('assigned_to', null)
        .order('created_at', { ascending: false }),
    ])

    staleItems     = (staleRes.data     ?? []) as ActionItem[]
    unassignedItems = (unassignedRes.data ?? []) as ActionItem[]
  }

  // De-duplicate: an item can appear in both lists
  const staleIds = new Set(staleItems.map(i => i.id))
  const unassignedOnly = unassignedItems.filter(i => !staleIds.has(i.id))

  const totalNotifs = staleItems.length + unassignedOnly.length

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">🔔 Notifications</h1>
        <p className="text-gray-400 text-sm mt-1">
          Tasks that need attention
        </p>
      </div>

      {!conn ? (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Go to Settings &amp; Connections first.</p>
        </div>
      ) : totalNotifs === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">✅</p>
          <p className="text-white font-medium">All clear!</p>
          <p className="text-gray-500 text-sm mt-1">No items need attention right now.</p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── Stale in-progress ─────────────────────────────────────────── */}
          {staleItems.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-red-400 text-lg">⏰</span>
                <h2 className="text-white font-semibold">
                  Stale In Progress
                  <span className="ml-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full font-normal">
                    {staleItems.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Items that have been in progress for more than {STALE_DAYS} days without being completed.
              </p>
              <div className="space-y-2">
                {staleItems.map(item => (
                  <NotifCard key={item.id} item={item} badge={
                    <span className="text-xs text-red-400 bg-red-500/10 px-2 py-0.5 rounded-full">
                      {daysAgo(item.created_at)}d in progress
                    </span>
                  } />
                ))}
              </div>
            </section>
          )}

          {/* ── Unassigned in-progress ────────────────────────────────────── */}
          {unassignedOnly.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-yellow-400 text-lg">👤</span>
                <h2 className="text-white font-semibold">
                  Unassigned In Progress
                  <span className="ml-2 text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full font-normal">
                    {unassignedOnly.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Items currently in progress with no one assigned to them.
              </p>
              <div className="space-y-2">
                {unassignedOnly.map(item => (
                  <NotifCard key={item.id} item={item} badge={
                    <span className="text-xs text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded-full">
                      Unassigned
                    </span>
                  } />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <p className="text-xs text-gray-700 mt-10">
        More notification types coming soon — brief status changes, ranking recovery, and more.
      </p>
    </div>
  )
}

function NotifCard({ item, badge }: { item: ActionItem; badge: React.ReactNode }) {
  const path = pagePath(item.page)
  const isOnPage = item.action_type === 'on_page'

  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-4 py-3 flex items-center gap-4 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
            isOnPage
              ? 'text-blue-400 bg-blue-500/10 border-blue-500/20'
              : 'text-purple-400 bg-purple-500/10 border-purple-500/20'
          }`}>
            {isOnPage ? '✏️ On-Page' : '📣 Off-Page'}
          </span>
          {badge}
          {item.assigned_to && (
            <span className="inline-flex items-center gap-1 text-xs text-gray-400 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-full">
              <span className="w-4 h-4 rounded-full bg-indigo-600 flex items-center justify-center text-[9px] font-bold text-white">
                {initials(item.assigned_to)}
              </span>
              {item.assigned_to.split('@')[0]}
            </span>
          )}
        </div>
        <p className="text-blue-400 text-sm font-medium truncate" title={item.page}>{path}</p>
        {item.notes && (
          <p className="text-gray-500 text-xs mt-0.5 truncate">{item.notes}</p>
        )}
      </div>
      <Link
        href={`/gsc/action-items/${item.id}`}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition flex-shrink-0"
      >
        View →
      </Link>
    </div>
  )
}
