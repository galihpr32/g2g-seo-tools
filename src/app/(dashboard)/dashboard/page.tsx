import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Link from 'next/link'

// ── Types ─────────────────────────────────────────────────────────────────────
type SparkPoint = { date: string; clicks: number; impressions: number }

type DashStats = {
  actionStats: {
    total: number; pending: number; in_progress: number; done: number
    on_page: number; off_page: number; unassigned_in_progress: number
  }
  weeklyItems: { week: string; count: number }[]
  briefStats: { total: number; generating: number; draft: number; reviewed: number; published: number }
  campaignStats: { total: number; totalPages: number }
  sparkline: SparkPoint[]
  totalClicksNow: number
  clicksDelta: number | null
  assignees: { email: string; in_progress: number; done: number; total: number }[]
  siteUrl: string | null
}

// ── SVG Sparkline (server-rendered) ──────────────────────────────────────────
function Sparkline({ points, color = '#f87171', height = 64 }: {
  points: number[]
  color?: string
  height?: number
}) {
  if (points.length < 2) return (
    <div className="h-16 flex items-center justify-center text-gray-600 text-xs">No data yet</div>
  )

  const w = 400
  const h = height
  const max = Math.max(...points)
  const min = Math.min(...points)
  const range = max - min || 1
  const pad = 4

  const coords = points.map((v, i) => {
    const x = pad + (i / (points.length - 1)) * (w - 2 * pad)
    const y = h - pad - ((v - min) / range) * (h - 2 * pad)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const pathD = `M ${coords.join(' L ')}`
  const areaD = `M ${coords[0]} L ${coords.join(' L ')} L ${(w - pad).toFixed(1)},${h} L ${pad},${h} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <defs>
        <linearGradient id={`grad-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#grad-${color.replace('#', '')})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, href }: {
  label: string; value: string | number; sub?: string; color: string; href?: string
}) {
  const inner = (
    <div className={`bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition`}>
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

// ── Brief pipeline bar ────────────────────────────────────────────────────────
function BriefPipeline({ stats }: { stats: DashStats['briefStats'] }) {
  const stages: { key: keyof typeof stats; label: string; color: string }[] = [
    { key: 'generating', label: 'Generating', color: 'bg-gray-600' },
    { key: 'draft',      label: 'Draft',      color: 'bg-yellow-500' },
    { key: 'reviewed',   label: 'Reviewed',   color: 'bg-blue-500' },
    { key: 'published',  label: 'Published',  color: 'bg-green-500' },
  ]
  const total = stats.total || 1

  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {stages.map(s => {
          const val = stats[s.key] as number
          const pct = (val / total) * 100
          if (!val) return null
          return (
            <div
              key={s.key}
              className={`${s.color} rounded-full`}
              style={{ width: `${pct}%`, minWidth: val ? 4 : 0 }}
              title={`${s.label}: ${val}`}
            />
          )
        })}
      </div>
      <div className="flex gap-4 flex-wrap">
        {stages.map(s => {
          const val = stats[s.key] as number
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${s.color}`} />
              <span className="text-xs text-gray-400">{s.label}</span>
              <span className="text-xs text-gray-300 font-medium">{val}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Weekly items bar chart ────────────────────────────────────────────────────
function WeeklyBars({ weeks }: { weeks: DashStats['weeklyItems'] }) {
  const max = Math.max(...weeks.map(w => w.count), 1)
  return (
    <div className="flex items-end gap-1.5 h-16">
      {weeks.map((w, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div
            className="w-full bg-red-700/70 rounded-t"
            style={{ height: `${Math.max((w.count / max) * 56, w.count ? 4 : 0)}px` }}
            title={`${w.week}: ${w.count} items`}
          />
          <span className="text-gray-600 text-[10px] leading-none hidden lg:block">
            {w.week.slice(0, 5)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  // Use service client for all data queries so workspace members can read the
  // owner's data regardless of Row Level Security policies.
  const db = createServiceClient()

  const { data: conn } = await db
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .maybeSingle()

  const siteUrl = conn?.site_url ?? null

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  // Parallel fetches
  const [itemsRes, briefsRes, campsRes, dropsRes] = await Promise.all([
    siteUrl
      ? db.from('seo_action_items')
          .select('id, status, action_type, assigned_to, created_at')
          .eq('site_url', siteUrl)
      : Promise.resolve({ data: [], error: null }),

    siteUrl
      ? db.from('seo_content_briefs')
          .select('id, status, created_at')
          .eq('site_url', siteUrl)
      : Promise.resolve({ data: [], error: null }),

    db.from('campaigns')
      .select('id, campaign_pages(id)')
      .eq('owner_user_id', ownerId),

    siteUrl
      ? db.from('gsc_ranking_drops')
          .select('snapshot_date, clicks_now, impressions_now')
          .eq('site_url', siteUrl)
          .gte('snapshot_date', thirtyDaysAgo)
          .order('snapshot_date', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ])

  const items  = itemsRes.data  ?? []
  const briefs = briefsRes.data ?? []
  const camps  = campsRes.data  ?? []
  const drops  = dropsRes.data  ?? []

  // ── Compute stats ──────────────────────────────────────────────────────────
  const actionStats = {
    total:      items.length,
    pending:    items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    done:       items.filter(i => i.status === 'done').length,
    unassigned_in_progress: items.filter(i => i.status === 'in_progress' && !i.assigned_to).length,
  }

  const briefStats = {
    total:      briefs.length,
    generating: briefs.filter(b => b.status === 'generating').length,
    draft:      briefs.filter(b => b.status === 'draft').length,
    reviewed:   briefs.filter(b => b.status === 'reviewed').length,
    published:  briefs.filter(b => b.status === 'published').length,
  }

  const campaignStats = {
    total: camps.length,
    totalPages: camps.reduce((s, c) => s + (Array.isArray(c.campaign_pages) ? c.campaign_pages.length : 0), 0),
  }

  // Clicks sparkline
  const clicksByDate = new Map<string, number>()
  for (const d of drops) {
    clicksByDate.set(d.snapshot_date, (clicksByDate.get(d.snapshot_date) ?? 0) + (d.clicks_now ?? 0))
  }
  const sparkline = Array.from(clicksByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, clicks]) => clicks)

  const totalClicks = sparkline.reduce((s, v) => s + v, 0)
  const half = Math.floor(sparkline.length / 2)
  const prevClicks = sparkline.slice(0, half).reduce((s, v) => s + v, 0)
  const currClicks = sparkline.slice(half).reduce((s, v) => s + v, 0)
  const clicksDelta = prevClicks > 0
    ? Math.round(((currClicks - prevClicks) / prevClicks) * 100)
    : null

  // Weekly items (last 8 weeks)
  const now = Date.now()
  const weeklyItems = Array.from({ length: 8 }, (_, w) => {
    const ws = new Date(now - (7 - w + 1) * 7 * 24 * 60 * 60 * 1000)
    const we = new Date(now - (7 - w) * 7 * 24 * 60 * 60 * 1000)
    return {
      week: ws.toISOString().slice(5, 10),
      count: items.filter(i => { const d = new Date(i.created_at); return d >= ws && d < we }).length,
    }
  })

  // Assignee table
  const assigneeMap = new Map<string, { in_progress: number; done: number }>()
  for (const item of items) {
    const key = item.assigned_to ?? '(unassigned)'
    if (!assigneeMap.has(key)) assigneeMap.set(key, { in_progress: 0, done: 0 })
    const e = assigneeMap.get(key)!
    if (item.status === 'in_progress') e.in_progress++
    if (item.status === 'done')        e.done++
  }
  const assignees = Array.from(assigneeMap.entries())
    .map(([email, c]) => ({ email, ...c, total: c.in_progress + c.done }))
    .filter(a => a.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)

  // Greeting
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = user.email?.split('@')[0] ?? 'there'

  const doneRate = actionStats.total > 0
    ? Math.round((actionStats.done / actionStats.total) * 100)
    : 0

  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          {greeting}, {firstName} 👋
        </h1>
        <p className="text-gray-400 mt-1 text-sm">
          {siteUrl
            ? <>SEO overview for <span className="text-gray-300">{siteUrl}</span></>
            : 'Connect Google Search Console in Settings to see live data.'}
        </p>
      </div>

      {/* ── Alert: unassigned in_progress ───────────────────────────── */}
      {actionStats.unassigned_in_progress > 0 && (
        <Link href="/gsc/action-items">
          <div className="mb-6 flex items-center gap-3 bg-yellow-900/20 border border-yellow-700/30 rounded-xl px-5 py-3 hover:border-yellow-600/40 transition cursor-pointer">
            <span className="text-yellow-400">⚠</span>
            <p className="text-yellow-300 text-sm font-medium">
              {actionStats.unassigned_in_progress} in-progress item{actionStats.unassigned_in_progress > 1 ? 's' : ''} without an assignee
            </p>
            <span className="ml-auto text-yellow-600 text-xs">View →</span>
          </div>
        </Link>
      )}

      {/* ── Stat cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Action Items"
          value={actionStats.total}
          sub={`${actionStats.in_progress} in progress · ${doneRate}% done`}
          color="text-red-400"
          href="/gsc/action-items"
        />
        <StatCard
          label="Content Briefs"
          value={briefStats.total}
          sub={`${briefStats.published} published · ${briefStats.draft} drafts`}
          color="text-blue-400"
        />
        <StatCard
          label="Campaigns"
          value={campaignStats.total}
          sub={`${campaignStats.totalPages} pages tracked`}
          color="text-purple-400"
          href="/campaigns"
        />
        <StatCard
          label="Clicks (30d)"
          value={totalClicks > 0 ? totalClicks.toLocaleString() : '—'}
          sub={clicksDelta !== null
            ? `${clicksDelta >= 0 ? '+' : ''}${clicksDelta}% vs prev period`
            : 'No GSC data yet'}
          color={clicksDelta !== null && clicksDelta >= 0 ? 'text-green-400' : 'text-red-400'}
        />
      </div>

      {/* ── Main grid ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Clicks sparkline */}
        <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-white font-medium text-sm">Clicks trend — last 30 days</h3>
              <p className="text-gray-500 text-xs mt-0.5">Aggregated across all tracked pages</p>
            </div>
            {clicksDelta !== null && (
              <span className={`text-sm font-semibold px-2.5 py-1 rounded-lg ${
                clicksDelta >= 0 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
              }`}>
                {clicksDelta >= 0 ? '▲' : '▼'} {Math.abs(clicksDelta)}%
              </span>
            )}
          </div>
          {sparkline.length > 1 ? (
            <Sparkline points={sparkline} color="#f87171" height={80} />
          ) : (
            <div className="h-20 flex items-center justify-center text-gray-600 text-sm">
              {siteUrl ? 'Run the daily sync to start collecting data.' : 'Connect GSC in Settings first.'}
            </div>
          )}
        </div>

        {/* Action items breakdown */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-white font-medium text-sm mb-4">Action items breakdown</h3>
          <div className="space-y-3">
            {[
              { label: 'Pending',     value: actionStats.pending,     color: 'bg-gray-600',  text: 'text-gray-400' },
              { label: 'In Progress', value: actionStats.in_progress, color: 'bg-yellow-500', text: 'text-yellow-400' },
              { label: 'Done',        value: actionStats.done,        color: 'bg-green-500',  text: 'text-green-400' },
            ].map(s => (
              <div key={s.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-400">{s.label}</span>
                  <span className={`text-xs font-semibold ${s.text}`}>{s.value}</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${s.color} rounded-full`}
                    style={{ width: actionStats.total > 0 ? `${(s.value / actionStats.total) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-800">
            <Link href="/gsc/action-items" className="text-xs text-gray-500 hover:text-gray-300 transition">
              View all action items →
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Brief pipeline */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-medium text-sm">Brief pipeline</h3>
            <span className="text-xs text-gray-500">{briefStats.total} total</span>
          </div>
          {briefStats.total > 0 ? (
            <BriefPipeline stats={briefStats} />
          ) : (
            <p className="text-gray-600 text-xs">No briefs generated yet.</p>
          )}
        </div>

        {/* Items added per week */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-white font-medium text-sm mb-4">New items — last 8 weeks</h3>
          {weeklyItems.some(w => w.count > 0) ? (
            <WeeklyBars weeks={weeklyItems} />
          ) : (
            <div className="h-16 flex items-center justify-center text-gray-600 text-xs">
              No items added recently
            </div>
          )}
        </div>

        {/* Quick links */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-white font-medium text-sm mb-4">Quick links</h3>
          <div className="space-y-2">
            {[
              { label: '📉 Ranking Drop Alert', href: '/gsc/ranking-drop' },
              { label: '🎯 Action Items',        href: '/gsc/action-items' },
              { label: '🗂️ Campaigns',           href: '/campaigns' },
              { label: '🔔 Notifications',       href: '/notifications' },
              { label: '⚙️ Settings',            href: '/settings' },
            ].map(l => (
              <Link
                key={l.href}
                href={l.href}
                className="block text-xs text-gray-400 hover:text-white hover:bg-gray-800 px-3 py-2 rounded-lg transition"
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* ── Assignee table ───────────────────────────────────────────── */}
      {assignees.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-800">
            <h3 className="text-white font-medium text-sm">Team breakdown</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium text-xs px-5 py-3">Assignee</th>
                <th className="text-right text-gray-500 font-medium text-xs px-5 py-3">In Progress</th>
                <th className="text-right text-gray-500 font-medium text-xs px-5 py-3">Done</th>
                <th className="text-right text-gray-500 font-medium text-xs px-5 py-3">Total</th>
                <th className="px-5 py-3 w-32" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {assignees.map(a => {
                const doneP = a.total > 0 ? Math.round((a.done / a.total) * 100) : 0
                return (
                  <tr key={a.email} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3.5 text-gray-200">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-indigo-700 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                          {a.email === '(unassigned)' ? '?' : (a.email[0] ?? '?').toUpperCase()}
                        </div>
                        <span className="text-xs truncate max-w-[160px]" title={a.email}>
                          {a.email === '(unassigned)' ? <span className="text-gray-500 italic">Unassigned</span> : a.email}
                        </span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right text-yellow-400 text-xs font-semibold">{a.in_progress}</td>
                    <td className="px-5 py-3.5 text-right text-green-400 text-xs font-semibold">{a.done}</td>
                    <td className="px-5 py-3.5 text-right text-gray-300 text-xs font-semibold">{a.total}</td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full" style={{ width: `${doneP}%` }} />
                        </div>
                        <span className="text-xs text-gray-500 w-8 text-right">{doneP}%</span>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
