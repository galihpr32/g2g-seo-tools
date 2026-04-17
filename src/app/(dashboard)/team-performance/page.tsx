import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId, canSeeTeamPerformance } from '@/lib/workspace'
import { redirect } from 'next/navigation'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

// ── Types ─────────────────────────────────────────────────────────────────────
type RawItem = {
  id: string
  page: string
  action_type: string
  status: string
  assigned_to: string | null
  created_at: string
  completed_at: string | null
  snapshot_date: string
}

type RawBrief = {
  id: string
  action_item_id: string
  status: string
}

type AssigneeStat = {
  email: string
  total: number
  pending: number
  in_progress: number
  done: number
  stale: number
  completion_rate: number
  briefs_published: number
  avg_completion_days: number | null
  weekly_velocity: number[]  // items completed per week, last 8 weeks
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function initials(email: string) {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

function avatarColor(email: string) {
  const colors = ['bg-indigo-600','bg-purple-600','bg-pink-600','bg-rose-600','bg-orange-600','bg-teal-600','bg-cyan-600','bg-blue-600']
  let hash = 0
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[hash]
}

function completionBar(rate: number, size: 'sm' | 'md' = 'sm') {
  const color = rate >= 70 ? 'bg-green-500' : rate >= 40 ? 'bg-yellow-500' : 'bg-red-500'
  const h     = size === 'md' ? 'h-2' : 'h-1.5'
  return { color, h }
}

// Mini SVG bar chart for weekly velocity
function VelocityBars({ weeks }: { weeks: number[] }) {
  const max = Math.max(...weeks, 1)
  return (
    <div className="flex items-end gap-0.5 h-8">
      {weeks.map((v, i) => (
        <div
          key={i}
          className="flex-1 bg-indigo-500/60 rounded-sm"
          style={{ height: `${Math.max((v / max) * 100, v > 0 ? 15 : 0)}%` }}
          title={`Week ${i + 1}: ${v} completed`}
        />
      ))}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function TeamPerformancePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const canView = await canSeeTeamPerformance(supabase, user.id)
  if (!canView) {
    return (
      <div className="p-8 max-w-lg">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-12 text-center">
          <div className="text-4xl mb-4">🔒</div>
          <h2 className="text-white font-semibold text-lg mb-2">Access restricted</h2>
          <p className="text-gray-400 text-sm">
            Team Performance is only available to workspace owners and managers.
          </p>
          <Link href="/dashboard" className="inline-block mt-6 text-sm text-indigo-400 hover:text-indigo-300">
            ← Back to Dashboard
          </Link>
        </div>
      </div>
    )
  }

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  // Get GSC site_url
  const { data: conn } = await supabase
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .maybeSingle()

  const siteUrl = conn?.site_url

  if (!siteUrl) {
    return (
      <div className="p-8 max-w-lg">
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-8 text-center">
          <p className="text-yellow-400 font-medium">GSC not connected</p>
          <p className="text-gray-400 text-sm mt-1">Connect Google Search Console in Settings first.</p>
        </div>
      </div>
    )
  }

  // ── Fetch all action items + briefs in parallel ─────────────────────────────
  const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [itemsRes, briefsRes, membersRes] = await Promise.all([
    supabase
      .from('seo_action_items')
      .select('id, page, action_type, status, assigned_to, created_at, completed_at, snapshot_date')
      .eq('site_url', siteUrl)
      .order('created_at', { ascending: false }),

    supabase
      .from('seo_content_briefs')
      .select('id, action_item_id, status')
      .eq('site_url', siteUrl),

    // Get team member list for display names
    supabase
      .from('workspace_members')
      .select('member_email, role, status')
      .eq('owner_user_id', ownerId)
      .eq('status', 'active'),
  ])

  const items   = (itemsRes.data   ?? []) as RawItem[]
  const briefs  = (briefsRes.data  ?? []) as RawBrief[]
  const members = membersRes.data ?? []

  // Map: action_item_id → brief status
  const briefStatusMap = new Map<string, string>()
  for (const b of briefs) {
    const existing = briefStatusMap.get(b.action_item_id)
    const rank = (s: string) => s === 'published' ? 4 : s === 'reviewed' ? 3 : s === 'draft' ? 2 : 1
    if (!existing || rank(b.status) > rank(existing)) {
      briefStatusMap.set(b.action_item_id, b.status)
    }
  }

  // ── Group items by assignee ────────────────────────────────────────────────
  const assigneeMap = new Map<string, RawItem[]>()
  for (const item of items) {
    const key = item.assigned_to ?? '__unassigned__'
    if (!assigneeMap.has(key)) assigneeMap.set(key, [])
    assigneeMap.get(key)!.push(item)
  }

  // ── Compute weekly velocity buckets (last 8 weeks) ─────────────────────────
  const now = Date.now()
  function weeklyCompleted(assigneeItems: RawItem[]): number[] {
    return Array.from({ length: 8 }, (_, w) => {
      const ws = new Date(now - (7 - w + 1) * 7 * 24 * 60 * 60 * 1000)
      const we = new Date(now - (7 - w)     * 7 * 24 * 60 * 60 * 1000)
      return assigneeItems.filter(i => {
        if (i.status !== 'done' || !i.completed_at) return false
        const d = new Date(i.completed_at)
        return d >= ws && d < we
      }).length
    })
  }

  // ── Build AssigneeStat[] ──────────────────────────────────────────────────
  const stats: AssigneeStat[] = []

  for (const [email, assigneeItems] of assigneeMap.entries()) {
    if (email === '__unassigned__') continue  // shown separately

    const done        = assigneeItems.filter(i => i.status === 'done')
    const in_progress = assigneeItems.filter(i => i.status === 'in_progress')
    const pending     = assigneeItems.filter(i => i.status === 'pending')
    const stale       = in_progress.filter(i => new Date(i.created_at) < new Date(staleThreshold))

    // Avg completion time (days) for done items that have completed_at
    const completedWithTime = done.filter(i => i.completed_at)
    const avgDays = completedWithTime.length > 0
      ? Math.round(
          completedWithTime.reduce((sum, i) => {
            return sum + (new Date(i.completed_at!).getTime() - new Date(i.created_at).getTime()) / 86_400_000
          }, 0) / completedWithTime.length
        )
      : null

    const briefs_published = assigneeItems.filter(i =>
      briefStatusMap.get(i.id) === 'published'
    ).length

    stats.push({
      email,
      total:            assigneeItems.length,
      pending:          pending.length,
      in_progress:      in_progress.length,
      done:             done.length,
      stale:            stale.length,
      completion_rate:  assigneeItems.length > 0 ? Math.round((done.length / assigneeItems.length) * 100) : 0,
      briefs_published,
      avg_completion_days: avgDays,
      weekly_velocity:  weeklyCompleted(assigneeItems),
    })
  }

  // Sort: by total desc
  stats.sort((a, b) => b.total - a.total)

  // ── Overall team numbers ──────────────────────────────────────────────────
  const assigned       = items.filter(i => i.assigned_to)
  const unassignedAll  = assigneeMap.get('__unassigned__') ?? []
  const totalDone      = items.filter(i => i.status === 'done').length
  const totalInProg    = items.filter(i => i.status === 'in_progress').length
  const totalStale     = items.filter(i => i.status === 'in_progress' && new Date(i.created_at) < new Date(staleThreshold)).length
  const overallRate    = items.length > 0 ? Math.round((totalDone / items.length) * 100) : 0
  const totalPublished = briefs.filter(b => b.status === 'published').length

  // Member role map for badges
  const roleMap = new Map(members.map(m => [m.member_email, m.role as string]))

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">👥 Team Performance</h1>
        <p className="text-gray-400 text-sm mt-1">
          Action item progress and brief output per team member
        </p>
      </div>

      {/* ── Overall summary cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {[
          { label: 'Total Items',       value: items.length,        color: 'text-white' },
          { label: 'Done',              value: totalDone,           color: 'text-green-400' },
          { label: 'In Progress',       value: totalInProg,         color: 'text-yellow-400' },
          { label: 'Briefs Published',  value: totalPublished,      color: 'text-blue-400' },
          { label: 'Stale (>7d)',       value: totalStale,          color: totalStale > 0 ? 'text-red-400' : 'text-gray-500' },
        ].map(card => (
          <div key={card.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">{card.label}</p>
            <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
          </div>
        ))}
      </div>

      {/* Overall completion bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-300 font-medium">Overall completion</span>
          <span className={`text-sm font-bold ${overallRate >= 70 ? 'text-green-400' : overallRate >= 40 ? 'text-yellow-400' : 'text-red-400'}`}>
            {overallRate}%
          </span>
        </div>
        <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${completionBar(overallRate, 'md').color}`}
            style={{ width: `${overallRate}%` }}
          />
        </div>
        <div className="flex gap-6 mt-3 text-xs text-gray-500">
          <span><span className="text-gray-300 font-medium">{assigned.length}</span> assigned</span>
          <span><span className="text-yellow-300 font-medium">{unassignedAll.length}</span> unassigned</span>
          <span><span className="text-gray-300 font-medium">{stats.length}</span> active assignees</span>
        </div>
      </div>

      {/* ── Per-assignee table ────────────────────────────────────────── */}
      {stats.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
          <p className="text-gray-500 text-sm">No items have been assigned to team members yet.</p>
          <Link href="/gsc/action-items" className="text-sm text-indigo-400 hover:text-indigo-300 mt-3 inline-block">
            Go to Action Items →
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {stats.map(s => {
            const { color: barColor, h: barH } = completionBar(s.completion_rate, 'md')
            const role = roleMap.get(s.email)

            return (
              <div key={s.email} className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-5 transition">
                <div className="flex items-start gap-4">
                  {/* Avatar */}
                  <div className={`w-10 h-10 rounded-full ${avatarColor(s.email)} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                    {initials(s.email)}
                  </div>

                  {/* Main content */}
                  <div className="flex-1 min-w-0">
                    {/* Name row */}
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      <span className="text-white font-medium text-sm truncate" title={s.email}>
                        {s.email.split('@')[0]}
                      </span>
                      <span className="text-gray-500 text-xs truncate">{s.email}</span>
                      {role && (
                        <span className={`text-xs px-2 py-0.5 rounded-full border flex-shrink-0 ${
                          role === 'manager'
                            ? 'text-purple-400 bg-purple-500/10 border-purple-500/20'
                            : 'text-gray-400 bg-gray-800 border-gray-700'
                        }`}>
                          {role}
                        </span>
                      )}
                      {s.stale > 0 && (
                        <span className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full flex-shrink-0">
                          ⏰ {s.stale} stale
                        </span>
                      )}
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-3">
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Total</p>
                        <p className="text-white font-semibold text-sm">{s.total}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Done</p>
                        <p className="text-green-400 font-semibold text-sm">{s.done}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">In Progress</p>
                        <p className="text-yellow-400 font-semibold text-sm">{s.in_progress}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Pending</p>
                        <p className="text-gray-400 font-semibold text-sm">{s.pending}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Briefs Published</p>
                        <p className="text-blue-400 font-semibold text-sm">{s.briefs_published}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 mb-0.5">Avg. Completion</p>
                        <p className="text-gray-300 font-semibold text-sm">
                          {s.avg_completion_days !== null ? `${s.avg_completion_days}d` : '—'}
                        </p>
                      </div>
                    </div>

                    {/* Completion bar + velocity */}
                    <div className="flex items-center gap-4">
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500">Completion rate</span>
                          <span className={`text-xs font-semibold ${
                            s.completion_rate >= 70 ? 'text-green-400' : s.completion_rate >= 40 ? 'text-yellow-400' : 'text-red-400'
                          }`}>{s.completion_rate}%</span>
                        </div>
                        <div className={`${barH} bg-gray-800 rounded-full overflow-hidden`}>
                          <div className={`h-full ${barColor} rounded-full`} style={{ width: `${s.completion_rate}%` }} />
                        </div>
                      </div>
                      {/* Weekly velocity mini-chart */}
                      <div className="flex-shrink-0 w-24">
                        <p className="text-xs text-gray-500 mb-1">Velocity (8w)</p>
                        <VelocityBars weeks={s.weekly_velocity} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── Unassigned section ────────────────────────────────────────── */}
      {unassignedAll.length > 0 && (
        <div className="mt-6 bg-gray-900 border border-yellow-800/30 rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-yellow-400">⚠</span>
              <span className="text-white font-medium text-sm">Unassigned items</span>
              <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded-full">
                {unassignedAll.length}
              </span>
            </div>
            <Link href="/gsc/action-items" className="text-xs text-gray-500 hover:text-gray-300 transition">
              View in Action Items →
            </Link>
          </div>
          <p className="text-gray-500 text-xs mt-2">
            {unassignedAll.filter(i => i.status === 'in_progress').length} in progress ·{' '}
            {unassignedAll.filter(i => i.status === 'pending').length} pending
          </p>
        </div>
      )}
    </div>
  )
}
