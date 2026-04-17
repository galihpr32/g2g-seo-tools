import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const STALE_DAYS    = 7
const ETA_WARN_DAYS = 3   // warn if ETA is within this many days

// ── Types ─────────────────────────────────────────────────────────────────────
type ActionItem = {
  id: string; page: string; action_type: 'on_page' | 'off_page'
  status: string; notes: string | null; assigned_to: string | null
  created_at: string; snapshot_date: string
}

type EtaPage = {
  id: string; page_url: string; notes: string | null; eta: string; status: string
  campaign_id: string; campaign_name: string; campaign_color: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pagePath(url: string) {
  try { return new URL(url).pathname } catch { return url }
}

function daysAgo(dateStr: string) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000)
}

function daysUntil(dateStr: string) {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000)
}

function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

// ── Components ────────────────────────────────────────────────────────────────
function NotifCard({ item, badge }: { item: ActionItem; badge: React.ReactNode }) {
  const path    = pagePath(item.page)
  const isOnPage = item.action_type === 'on_page'
  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-4 py-3 flex items-center gap-4 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${isOnPage ? 'text-blue-400 bg-blue-500/10 border-blue-500/20' : 'text-purple-400 bg-purple-500/10 border-purple-500/20'}`}>
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
        {item.notes && <p className="text-gray-500 text-xs mt-0.5 truncate">{item.notes}</p>}
      </div>
      <Link href={`/gsc/action-items/${item.id}`}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition flex-shrink-0">
        View →
      </Link>
    </div>
  )
}

function EtaCard({ page }: { page: EtaPage }) {
  const until = daysUntil(page.eta)
  const overdue = until < 0
  const today   = until === 0
  const path    = pagePath(page.page_url)

  return (
    <div className={`bg-gray-900 border rounded-xl px-4 py-3 flex items-center gap-4 transition ${overdue ? 'border-red-800/50 hover:border-red-700/50' : 'border-gray-800 hover:border-gray-700'}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          {/* Campaign badge */}
          <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-300">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: page.campaign_color }} />
            {page.campaign_name}
          </span>
          {/* ETA badge */}
          {overdue ? (
            <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
              Overdue by {Math.abs(until)}d
            </span>
          ) : today ? (
            <span className="text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-full">
              Due today
            </span>
          ) : (
            <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
              Due in {until}d
            </span>
          )}
          {/* Page status */}
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            page.status === 'in_progress'
              ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
              : 'text-gray-400 bg-gray-800 border-gray-700'
          }`}>
            {page.status === 'in_progress' ? 'In progress' : 'Not started'}
          </span>
        </div>
        <p className="text-blue-400 text-sm font-medium truncate" title={page.page_url}>{path}</p>
        {page.notes && <p className="text-gray-500 text-xs mt-0.5 truncate">{page.notes}</p>}
        <p className="text-gray-600 text-xs mt-0.5">ETA: {page.eta}</p>
      </div>
      <Link href="/campaigns"
        className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white transition flex-shrink-0">
        View →
      </Link>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function NotificationsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const ownerId = user ? await getEffectiveOwnerId(supabase, user.id) : null

  const { data: conn } = ownerId
    ? await supabase.from('gsc_connections').select('site_url').eq('user_id', ownerId).single()
    : { data: null }

  const siteUrl = conn?.site_url

  let staleItems:     ActionItem[] = []
  let unassignedItems: ActionItem[] = []
  let etaPages:        EtaPage[]    = []

  if (ownerId) {
    const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const etaThreshold   = new Date(Date.now() + ETA_WARN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const today          = new Date().toISOString().slice(0, 10)

    const [staleRes, unassignedRes, etaRes] = await Promise.all([
      // Stale in_progress action items
      siteUrl
        ? supabase.from('seo_action_items')
            .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
            .eq('site_url', siteUrl).eq('status', 'in_progress')
            .lt('created_at', staleThreshold).order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),

      // Unassigned in_progress action items
      siteUrl
        ? supabase.from('seo_action_items')
            .select('id, page, action_type, status, notes, assigned_to, created_at, snapshot_date')
            .eq('site_url', siteUrl).eq('status', 'in_progress')
            .is('assigned_to', null).order('created_at', { ascending: false })
        : Promise.resolve({ data: [] }),

      // Campaign pages with overdue or upcoming ETA
      supabase.from('campaign_pages')
        .select('id, page_url, notes, eta, status, campaign_id, campaigns!inner(name, color, owner_user_id)')
        .eq('campaigns.owner_user_id', ownerId)
        .neq('status', 'done')
        .not('eta', 'is', null)
        .lte('eta', etaThreshold)
        .order('eta', { ascending: true }),
    ])

    staleItems      = (staleRes.data      ?? []) as ActionItem[]
    unassignedItems = (unassignedRes.data ?? []) as ActionItem[]

    // Shape ETA results
    etaPages = ((etaRes.data ?? []) as {
      id: string; page_url: string; notes: string | null; eta: string; status: string
      campaign_id: string
      campaigns: { name: string; color: string; owner_user_id: string } | { name: string; color: string; owner_user_id: string }[]
    }[]).map(row => {
      const camp = Array.isArray(row.campaigns) ? row.campaigns[0] : row.campaigns
      return {
        id: row.id, page_url: row.page_url, notes: row.notes, eta: row.eta,
        status: row.status, campaign_id: row.campaign_id,
        campaign_name: camp?.name ?? '', campaign_color: camp?.color ?? '#6366f1',
      }
    })
  }

  // De-duplicate stale + unassigned
  const staleIds       = new Set(staleItems.map(i => i.id))
  const unassignedOnly = unassignedItems.filter(i => !staleIds.has(i.id))

  const totalNotifs = staleItems.length + unassignedOnly.length + etaPages.length

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-8">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">🔔 Notifications</h1>
          {totalNotifs > 0 && (
            <span className="text-sm font-semibold bg-red-600 text-white rounded-full px-2.5 py-0.5">
              {totalNotifs}
            </span>
          )}
        </div>
        <p className="text-gray-400 text-sm mt-1">Tasks and campaign pages that need attention</p>
      </div>

      {totalNotifs === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-12 text-center">
          <p className="text-4xl mb-3">✅</p>
          <p className="text-white font-medium">All clear!</p>
          <p className="text-gray-500 text-sm mt-1">No items need attention right now.</p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── ETA overdue / upcoming ───────────────────────────────────── */}
          {etaPages.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-orange-400 text-lg">📅</span>
                <h2 className="text-white font-semibold">
                  Campaign ETAs
                  <span className="ml-2 text-xs text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded-full font-normal">
                    {etaPages.length}
                  </span>
                </h2>
              </div>
              <p className="text-gray-500 text-xs mb-3">
                Campaign pages that are overdue or due within {ETA_WARN_DAYS} days.
              </p>
              <div className="space-y-2">
                {etaPages.map(p => <EtaCard key={p.id} page={p} />)}
              </div>
            </section>
          )}

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
                Items in progress for more than {STALE_DAYS} days.
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
                Items in progress with no one assigned.
              </p>
              <div className="space-y-2">
                {unassignedOnly.map(item => (
                  <NotifCard key={item.id} item={item} badge={
                    <span className="text-xs text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded-full">Unassigned</span>
                  } />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
