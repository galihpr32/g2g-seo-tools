import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Link from 'next/link'

// ── Types ─────────────────────────────────────────────────────────────────────
type SparkPoint = { date: string; clicks: number }

// ── SVG Chart with date axis ──────────────────────────────────────────────────
function ClicksChart({ points }: { points: SparkPoint[] }) {
  if (points.length < 2) return (
    <div className="h-24 flex items-center justify-center text-gray-600 text-xs">
      No click data yet — run the GSC daily sync to start collecting.
    </div>
  )

  const w = 600
  const h = 80
  const padX = 4
  const padY = 6

  const values = points.map(p => p.clicks)
  const max    = Math.max(...values)
  const min    = Math.min(...values)
  const range  = max - min || 1

  const coords = points.map((p, i) => {
    const x = padX + (i / (points.length - 1)) * (w - 2 * padX)
    const y = padY + ((max - p.clicks) / range) * (h - 2 * padY)
    return { x, y, ...p }
  })

  const pathD = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)},${h} L ${coords[0].x.toFixed(1)},${h} Z`

  // Pick ~4 date tick positions
  const tickIdxs = [
    0,
    Math.floor(points.length * 0.33),
    Math.floor(points.length * 0.66),
    points.length - 1,
  ].filter((v, i, arr) => arr.indexOf(v) === i)

  const fmtDate = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 80 }}>
        <defs>
          <linearGradient id="grad-red" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f87171" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#f87171" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#grad-red)" />
        <path d={pathD} fill="none" stroke="#f87171" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" />
        {/* Tick dots */}
        {tickIdxs.map(i => (
          <circle key={i} cx={coords[i].x} cy={coords[i].y} r="2.5" fill="#f87171" />
        ))}
      </svg>
      {/* Date labels */}
      <div className="relative" style={{ height: 18 }}>
        {tickIdxs.map(i => {
          const pct = (i / (points.length - 1)) * 100
          return (
            <span
              key={i}
              className="absolute text-[10px] text-gray-600 whitespace-nowrap"
              style={{
                left:      `${pct}%`,
                transform: i === 0
                  ? 'none'
                  : i === points.length - 1
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
              }}
            >
              {fmtDate(points[i].date)}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, href }: {
  label: string; value: string | number; sub?: string; color: string; href?: string
}) {
  const inner = (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 hover:border-gray-700 transition">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
  return href ? <Link href={href}>{inner}</Link> : inner
}

// ── Brief pipeline bar ────────────────────────────────────────────────────────
function BriefPipeline({ stats }: {
  stats: { total: number; generating: number; draft: number; reviewed: number; published: number }
}) {
  const stages = [
    { key: 'generating' as const, label: 'Generating', color: 'bg-gray-600'   },
    { key: 'draft'      as const, label: 'Draft',      color: 'bg-yellow-500' },
    { key: 'reviewed'   as const, label: 'Reviewed',   color: 'bg-blue-500'   },
    { key: 'published'  as const, label: 'Published',  color: 'bg-green-500'  },
  ]
  const total = stats.total || 1
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5">
        {stages.map(s => {
          const val = stats[s.key]
          if (!val) return null
          return (
            <div key={s.key} className={`${s.color} rounded-full`}
              style={{ width: `${(val / total) * 100}%`, minWidth: 4 }}
              title={`${s.label}: ${val}`} />
          )
        })}
      </div>
      <div className="flex gap-4 flex-wrap">
        {stages.map(s => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${s.color}`} />
            <span className="text-xs text-gray-400">{s.label}</span>
            <span className="text-xs text-gray-300 font-medium">{stats[s.key]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Weekly items bar chart ────────────────────────────────────────────────────
function WeeklyBars({ weeks }: { weeks: { week: string; count: number }[] }) {
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

// ── Agent status badge ────────────────────────────────────────────────────────
const AGENT_LABELS: Record<string, string> = {
  heimdall: 'Heimdall', odin: 'Odin', loki: 'Loki',
  bragi: 'Bragi', hermod: 'Hermod', saga: 'Saga',
  tyr: 'Tyr', vor: 'Vor',
}
const AGENT_CATEGORY: Record<string, { color: string; dot: string }> = {
  heimdall: { color: 'text-blue-400',  dot: 'bg-blue-400'  },
  odin:     { color: 'text-blue-400',  dot: 'bg-blue-400'  },
  loki:     { color: 'text-blue-400',  dot: 'bg-blue-400'  },
  bragi:    { color: 'text-green-400', dot: 'bg-green-400' },
  hermod:   { color: 'text-green-400', dot: 'bg-green-400' },
  saga:     { color: 'text-green-400', dot: 'bg-green-400' },
  tyr:      { color: 'text-amber-400', dot: 'bg-amber-400' },
  vor:      { color: 'text-amber-400', dot: 'bg-amber-400' },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1)  return `${Math.floor(diff / 60_000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data: conn } = await db
    .from('gsc_connections')
    .select('site_url')
    .eq('user_id', ownerId)
    .maybeSingle()

  const siteUrl      = conn?.site_url ?? null
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  // ── Parallel fetches ──────────────────────────────────────────────────────
  const [itemsRes, briefsRes, campsRes, snapsRes, agentRunsRes, pendingActionsRes] =
    await Promise.all([
      siteUrl
        ? db.from('seo_action_items')
            .select('id, status, action_type, assigned_to, created_at')
            .eq('site_url', siteUrl)
        : Promise.resolve({ data: [] as Array<{ id: string; status: string; action_type: string | null; assigned_to: string | null; created_at: string }>, error: null }),

      siteUrl
        ? db.from('seo_content_briefs')
            .select('id, status, created_at')
            .eq('site_url', siteUrl)
        : Promise.resolve({ data: [] as Array<{ id: string; status: string; created_at: string }>, error: null }),

      db.from('campaigns')
        .select('id, campaign_pages(id)')
        .eq('owner_user_id', ownerId),

      // ✅ Correct table: gsc_ranking_snapshots has all-page traffic, not just drops
      siteUrl
        ? db.from('gsc_ranking_snapshots')
            .select('snapshot_date, clicks, impressions')
            .eq('site_url', siteUrl)
            .gte('snapshot_date', thirtyDaysAgo)
            .order('snapshot_date', { ascending: true })
        : Promise.resolve({ data: [] as Array<{ snapshot_date: string; clicks: number | null; impressions: number | null }>, error: null }),

      // Agent runs — last run per agent
      db.from('agent_runs')
        .select('agent_key, status, summary, actions_queued, started_at, finished_at')
        .eq('owner_user_id', ownerId)
        .order('started_at', { ascending: false })
        .limit(40),

      // Pending agent actions (approval queue)
      db.from('agent_actions')
        .select('agent_key, title, priority')
        .eq('owner_user_id', ownerId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(5),
    ])

  const items          = itemsRes.data  ?? []
  const briefs         = briefsRes.data ?? []
  const camps          = campsRes.data  ?? []
  const snaps          = snapsRes.data  ?? []
  const allRuns        = agentRunsRes.data ?? []
  const pendingActions = pendingActionsRes.data ?? []

  // ── Action stats ──────────────────────────────────────────────────────────
  const actionStats = {
    total:      items.length,
    pending:    items.filter(i => i.status === 'pending').length,
    in_progress: items.filter(i => i.status === 'in_progress').length,
    done:       items.filter(i => i.status === 'done').length,
    unassigned_in_progress: items.filter(i => i.status === 'in_progress' && !i.assigned_to).length,
  }
  const doneRate = actionStats.total > 0
    ? Math.round((actionStats.done / actionStats.total) * 100) : 0

  // ── Brief stats ───────────────────────────────────────────────────────────
  const briefStats = {
    total:      briefs.length,
    generating: briefs.filter(b => b.status === 'generating').length,
    draft:      briefs.filter(b => b.status === 'draft').length,
    reviewed:   briefs.filter(b => b.status === 'reviewed').length,
    published:  briefs.filter(b => b.status === 'published').length,
  }

  // ── Campaign stats ────────────────────────────────────────────────────────
  const campaignStats = {
    total: camps.length,
    totalPages: camps.reduce((s, c) =>
      s + (Array.isArray(c.campaign_pages) ? c.campaign_pages.length : 0), 0),
  }

  // ── Clicks sparkline — aggregate by date ──────────────────────────────────
  const clicksByDate = new Map<string, number>()
  for (const s of snaps) {
    const prev = clicksByDate.get(s.snapshot_date) ?? 0
    clicksByDate.set(s.snapshot_date, prev + (s.clicks ?? 0))
  }
  const sparkPoints: SparkPoint[] = Array.from(clicksByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, clicks]) => ({ date, clicks }))

  const totalClicks = sparkPoints.reduce((s, p) => s + p.clicks, 0)
  const half = Math.floor(sparkPoints.length / 2)
  const prevClicks = sparkPoints.slice(0, half).reduce((s, p) => s + p.clicks, 0)
  const currClicks = sparkPoints.slice(half).reduce((s, p) => s + p.clicks, 0)
  const clicksDelta = prevClicks > 0
    ? Math.round(((currClicks - prevClicks) / prevClicks) * 100) : null

  // ── Agent run summary — last run per agent ────────────────────────────────
  const lastRunByAgent = new Map<string, typeof allRuns[0]>()
  for (const r of allRuns) {
    if (!lastRunByAgent.has(r.agent_key)) lastRunByAgent.set(r.agent_key, r)
  }
  const agentSummary = Array.from(lastRunByAgent.entries())
    .map(([key, run]) => ({ key, ...run }))
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))

  // ── Weekly items (last 8 weeks) ───────────────────────────────────────────
  const now = Date.now()
  const weeklyItems = Array.from({ length: 8 }, (_, w) => {
    const ws = new Date(now - (7 - w + 1) * 7 * 86_400_000)
    const we = new Date(now - (7 - w) * 7 * 86_400_000)
    return {
      week:  ws.toISOString().slice(5, 10),
      count: items.filter(i => { const d = new Date(i.created_at); return d >= ws && d < we }).length,
    }
  })

  // ── Assignee table ────────────────────────────────────────────────────────
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

  // ── Greeting ──────────────────────────────────────────────────────────────
  const hour      = new Date().getHours()
  const greeting  = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = user.email?.split('@')[0] ?? 'there'

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

      {/* ── Alert banner ──────────────────────────────────────────────── */}
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

      {/* ── Stat cards ────────────────────────────────────────────────── */}
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
          href="/content/briefs"
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

      {/* ── Row 1: Clicks chart + Action items breakdown ───────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Clicks chart */}
        <div className="lg:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-white font-medium text-sm">Clicks trend — last 30 days</h3>
              <p className="text-gray-500 text-xs mt-0.5">Total daily clicks across all tracked pages</p>
            </div>
            {clicksDelta !== null && (
              <span className={`text-sm font-semibold px-2.5 py-1 rounded-lg ${
                clicksDelta >= 0 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'
              }`}>
                {clicksDelta >= 0 ? '▲' : '▼'} {Math.abs(clicksDelta)}%
              </span>
            )}
          </div>
          <ClicksChart points={sparkPoints} />
        </div>

        {/* Action items breakdown */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <h3 className="text-white font-medium text-sm mb-4">Action items breakdown</h3>
          <div className="space-y-3">
            {[
              { label: 'Pending',     value: actionStats.pending,     color: 'bg-gray-600',   text: 'text-gray-400'   },
              { label: 'In Progress', value: actionStats.in_progress, color: 'bg-yellow-500', text: 'text-yellow-400' },
              { label: 'Done',        value: actionStats.done,        color: 'bg-green-500',  text: 'text-green-400'  },
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

      {/* ── Row 2: Agent activity + Brief pipeline + New items ─────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Agent activity */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-white font-medium text-sm">Agent activity</h3>
            <Link href="/command-center" className="text-xs text-gray-500 hover:text-gray-300 transition">
              Command Center →
            </Link>
          </div>

          {agentSummary.length === 0 ? (
            <p className="text-gray-600 text-xs">No agents have run yet. Trigger one from Command Center or via Mimir.</p>
          ) : (
            <div className="space-y-2">
              {agentSummary.slice(0, 6).map(r => {
                const cat = AGENT_CATEGORY[r.key] ?? { color: 'text-gray-400', dot: 'bg-gray-600' }
                const statusEmoji = r.status === 'success' ? '✅' : r.status === 'running' ? '⏳' : r.status === 'partial' ? '⚠️' : '❌'
                return (
                  <div key={r.key} className="flex items-start gap-2.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${cat.dot} mt-1.5 flex-shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className={`text-xs font-semibold ${cat.color}`}>
                          {AGENT_LABELS[r.key] ?? r.key}
                        </span>
                        <span className="text-[10px] text-gray-600 flex-shrink-0">
                          {r.started_at ? timeAgo(r.started_at) : '—'}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 leading-tight mt-0.5 truncate">
                        {statusEmoji} {r.summary?.slice(0, 60) ?? 'No summary'}
                        {r.summary && r.summary.length > 60 ? '…' : ''}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Pending actions in approval queue */}
          {pendingActions.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-800">
              <p className="text-[11px] text-amber-400 font-semibold mb-2">
                {pendingActions.length} action{pendingActions.length > 1 ? 's' : ''} awaiting approval
              </p>
              {pendingActions.slice(0, 3).map((a, i) => (
                <p key={i} className="text-[11px] text-gray-500 truncate mb-1">
                  [{a.agent_key}] {a.title}
                </p>
              ))}
              <Link href="/command-center" className="text-xs text-amber-500 hover:text-amber-400 transition">
                Review in Command Center →
              </Link>
            </div>
          )}
        </div>

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
          {briefStats.total > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-800">
              <Link href="/content/briefs" className="text-xs text-gray-500 hover:text-gray-300 transition">
                View brief library →
              </Link>
            </div>
          )}
        </div>

        {/* New items per week */}
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
      </div>

      {/* ── Assignee table ─────────────────────────────────────────── */}
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
                          {a.email === '(unassigned)'
                            ? <span className="text-gray-500 italic">Unassigned</span>
                            : a.email}
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
