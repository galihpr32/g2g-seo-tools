// Sprint WEEKLY.PUBLIC — login-free public weekly report viewer.
// Renders read-only. No sidebar, no nav, no auth — pure UUID token gate.
// Designed for CEOs / cross-functional managers without dashboard access.

import { createServiceClient } from '@/lib/supabase/service'
import { notFound } from 'next/navigation'

// Marked dynamic so each visit re-reads the latest curatorial edits
export const dynamic      = 'force-dynamic'
export const fetchCache   = 'force-no-store'

interface ReportRow {
  id:               string
  week_start:       string
  week_end:         string
  site_slug:        string
  publish_status:   string
  report_data:      Record<string, unknown> | null
  ai_narrative:     string | null
  ai_action_plan:   string | null
  curatorial_edits: Record<string, unknown> | null
}

interface GSCData {
  weekClicks?:        number
  weekImpressions?:   number
  avgPosition?:       number
  clicksPct?:         number
  impressionsPct?:    number
  topGainers?:        Array<{ page: string; delta: number }>
  topLosers?:         Array<{ page: string; delta: number }>
}

interface TierData {
  top3?:          number
  top10?:         number
  top3Delta?:     number
  top10Delta?:    number
  tier1AvgPos?:   number
  tier2AvgPos?:   number
}

export default async function PublicWeeklyReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!token || token.length < 8) notFound()

  const db = createServiceClient()
  const { data, error } = await db
    .from('weekly_reports')
    .select('id, week_start, week_end, site_slug, publish_status, report_data, ai_narrative, ai_action_plan, curatorial_edits')
    .eq('public_token', token)
    .maybeSingle()

  if (error || !data) notFound()
  const r = data as ReportRow

  // ── Resolve final content (curatorial edits replace AI when present) ──
  const edits = (r.curatorial_edits ?? {}) as { narrative?: string; action_plan?: string; watch_list?: string[]; top_priorities?: string[] }
  const narrative   = edits.narrative   ?? r.ai_narrative   ?? '(narrative not generated)'
  const actionPlan  = edits.action_plan ?? r.ai_action_plan ?? ''
  const watchList   = edits.watch_list  ?? []
  const priorities  = edits.top_priorities ?? actionPlan.split('\n').filter(Boolean).slice(0, 5)

  const rd          = (r.report_data ?? {}) as Record<string, unknown>
  const gsc         = (rd.gsc as GSCData) ?? {}
  const tier        = (rd.tierStatus as TierData) ?? {}
  const weekLabel   = (rd.weekLabel as string) ?? formatWeekLabel(r.week_start, r.week_end)
  const brandLabel  = r.site_slug === 'offgamers' ? 'OffGamers' : 'G2G'
  const brandAccent = r.site_slug === 'offgamers' ? '#2563EB' : '#DC2626'

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gradient-to-br from-gray-900 to-gray-950">
        <div className="max-w-3xl mx-auto px-6 py-6 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-6 rounded" style={{ backgroundColor: brandAccent }} />
              <h1 className="text-lg font-bold text-white">{brandLabel} — Weekly SEO Performance</h1>
            </div>
            <p className="text-xs text-gray-400">{weekLabel}</p>
          </div>
          <span className="text-[10px] text-gray-600 tracking-wider uppercase">Read-only</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-8">

        {/* ── Section: The Headline ─────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
            <span className="text-base">🎯</span>The headline
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Clicks"        value={fmtNum(gsc.weekClicks)}      delta={gsc.clicksPct}      />
            <KpiCard label="Impressions"   value={fmtNum(gsc.weekImpressions)} delta={gsc.impressionsPct} />
            <KpiCard label="Avg Position"  value={gsc.avgPosition != null ? `#${gsc.avgPosition.toFixed(1)}` : '—'} delta={null} />
            <KpiCard label="Top Mover"     value={gsc.topGainers?.[0]?.page ? trimPath(gsc.topGainers[0].page) : '—'} delta={gsc.topGainers?.[0]?.delta} small />
          </div>
        </section>

        {/* ── Section: Tier Status ──────────────────────────────────────── */}
        {(tier.top3 != null || tier.top10 != null) && (
          <section>
            <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-base">🥇</span>Tier status
            </h2>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <TierStat label="Top 3"        value={tier.top3 ?? 0}  delta={tier.top3Delta} />
              <TierStat label="Top 10"       value={tier.top10 ?? 0} delta={tier.top10Delta} />
              <TierStat label="Tier 1 avg"   value={tier.tier1AvgPos != null ? `#${tier.tier1AvgPos.toFixed(1)}` : '—'} />
              <TierStat label="Tier 2 avg"   value={tier.tier2AvgPos != null ? `#${tier.tier2AvgPos.toFixed(1)}` : '—'} />
            </div>
          </section>
        )}

        {/* ── Section: Executive Summary ───────────────────────────────── */}
        {narrative && (
          <section>
            <h2 className="text-sm font-bold text-white mb-3">Executive summary</h2>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
              {narrative}
            </div>
          </section>
        )}

        {/* ── Section: Watch list ──────────────────────────────────────── */}
        {watchList.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-base">⚠️</span>Watch list ({watchList.length})
            </h2>
            <ul className="space-y-2">
              {watchList.map((item, i) => (
                <li key={i} className="rounded-md border border-amber-700/30 bg-amber-500/5 p-3 text-sm text-gray-200">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Section: Next week priorities ─────────────────────────────── */}
        {priorities.length > 0 && (
          <section>
            <h2 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-base">✅</span>Next week — top {Math.min(priorities.length, 3)} priorities
            </h2>
            <ol className="space-y-2 list-decimal pl-5">
              {priorities.slice(0, 5).map((p, i) => (
                <li key={i} className="text-sm text-gray-200 pl-1">{p}</li>
              ))}
            </ol>
          </section>
        )}

        {/* ── Section: Top movers (optional, if data exists) ───────────── */}
        {(gsc.topGainers?.length || gsc.topLosers?.length) && (
          <section>
            <h2 className="text-sm font-bold text-white mb-3">Top movers</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <MoverList title="🟢 Gainers" rows={gsc.topGainers ?? []} positive />
              <MoverList title="🔴 Losers"  rows={gsc.topLosers  ?? []} positive={false} />
            </div>
          </section>
        )}

        <footer className="pt-6 border-t border-gray-800 text-xs text-gray-500 text-center">
          Generated by G2G SEO Tools · Status: <span className={r.publish_status === 'published' || r.publish_status === 'auto_published' ? 'text-emerald-400' : 'text-amber-400'}>{r.publish_status}</span>
        </footer>
      </main>
    </div>
  )
}

// ─── Mini components ────────────────────────────────────────────────────

function KpiCard({ label, value, delta, small }: { label: string; value: string; delta?: number | null; small?: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{label}</div>
      <div className={`font-bold text-white ${small ? 'text-xs truncate' : 'text-lg'}`}>{value}</div>
      {delta != null && (
        <div className={`text-xs mt-1 ${delta >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
          {delta >= 0 ? '↑' : '↓'} {Math.abs(delta).toFixed(0)}{small ? ' clicks' : '%'}
        </div>
      )}
    </div>
  )
}

function TierStat({ label, value, delta }: { label: string; value: number | string; delta?: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{label}</div>
      <div className="text-base font-bold text-white">
        {value}
        {delta != null && delta !== 0 && (
          <span className={`text-xs ml-1.5 ${delta > 0 ? 'text-emerald-300' : 'text-red-300'}`}>
            ({delta > 0 ? '+' : ''}{delta})
          </span>
        )}
      </div>
    </div>
  )
}

function MoverList({ title, rows, positive }: { title: string; rows: Array<{ page: string; delta: number }>; positive: boolean }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3">
      <h3 className="text-xs font-semibold text-gray-300 mb-2">{title}</h3>
      <ul className="space-y-1">
        {rows.slice(0, 5).map((r, i) => (
          <li key={i} className="text-xs flex items-center justify-between gap-2">
            <code className="text-gray-300 truncate">{trimPath(r.page)}</code>
            <span className={positive ? 'text-emerald-300' : 'text-red-300'}>
              {positive ? '+' : ''}{fmtNum(r.delta)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function fmtNum(n?: number | null): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function trimPath(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40)
}

function formatWeekLabel(start: string, end: string): string {
  const s = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const e = new Date(end).toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}
