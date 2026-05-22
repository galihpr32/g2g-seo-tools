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
  weekClicks?:         number
  prevWeekClicks?:     number
  weekImpressions?:    number
  prevWeekImpressions?: number
  weekCtr?:            number
  prevWeekCtr?:        number
  ctrPct?:             number | null
  avgPosition?:        number
  clicksPct?:          number
  impressionsPct?:     number
  topGainers?:         Array<{ page: string; delta: number }>
  topLosers?:          Array<{ page: string; delta: number }>
}

interface GA4Data {
  weekSessions?:       number
  prevWeekSessions?:   number
  sessionsPct?:        number | null
  totalRevenue?:       number
  prevRevenue?:        number
  revenuePct?:         number | null
  totalPurchases?:     number
  prevPurchases?:      number
  purchasesPct?:       number | null
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

  // Sprint WEEKLY.PUBLIC.SWITCHER — look up latest published token per brand
  // so the header can offer "Latest G2G" / "Latest OffGamers" links. Lets
  // recipients of an old shared link jump to current week or other brand
  // without having to hunt for a fresh URL. Runs in parallel with the main
  // fetch above so no perceived delay.
  const { data: latestByBrand } = await db
    .from('weekly_reports')
    .select('site_slug, public_token, week_start, week_end')
    .eq('publish_status', 'published')
    .not('public_token', 'is', null)
    .in('site_slug', ['g2g', 'offgamers'])
    .order('week_start', { ascending: false })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestByBrandRows = (latestByBrand ?? []) as any[]
  // First row per site_slug wins (already sorted by week_start desc).
  const latestG2g = latestByBrandRows.find(x => x.site_slug === 'g2g')        ?? null
  const latestOg  = latestByBrandRows.find(x => x.site_slug === 'offgamers')  ?? null

  // ── Resolve final content (curatorial edits replace AI when present) ──
  const edits = (r.curatorial_edits ?? {}) as { narrative?: string; action_plan?: string; watch_list?: string[]; top_priorities?: string[] }
  const narrative   = edits.narrative   ?? r.ai_narrative   ?? '(narrative not generated)'
  const actionPlan  = edits.action_plan ?? r.ai_action_plan ?? ''
  const watchList   = edits.watch_list  ?? []
  const priorities  = edits.top_priorities ?? actionPlan.split('\n').filter(Boolean).slice(0, 5)

  const rd          = (r.report_data ?? {}) as Record<string, unknown>
  const gsc         = (rd.gsc as GSCData) ?? {}
  const ga4         = (rd.ga4 as GA4Data) ?? {}
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

        {/* Sprint WEEKLY.PUBLIC.SWITCHER — brand + latest jumpers.
            Shown only when at least one OTHER brand/week is available to jump to.
            Each link auto-resolves to that brand's most recent published token. */}
        {(latestG2g || latestOg) && (
          <div className="max-w-3xl mx-auto px-6 pb-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-gray-500">Jump to:</span>

              {latestG2g && (
                <a
                  href={`/public/weekly/${latestG2g.public_token}`}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border transition ${
                    r.site_slug === 'g2g' && latestG2g.public_token === token
                      ? 'border-violet-500/60 bg-violet-500/10 text-violet-200'
                      : 'border-gray-700 bg-gray-900/40 text-gray-300 hover:border-violet-500/40 hover:bg-violet-500/5'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
                  Latest G2G
                  <span className="text-[10px] text-gray-500">{formatWeekLabel(latestG2g.week_start, latestG2g.week_end)}</span>
                </a>
              )}

              {latestOg && (
                <a
                  href={`/public/weekly/${latestOg.public_token}`}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border transition ${
                    r.site_slug === 'offgamers' && latestOg.public_token === token
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200'
                      : 'border-gray-700 bg-gray-900/40 text-gray-300 hover:border-emerald-500/40 hover:bg-emerald-500/5'
                  }`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Latest OffGamers
                  <span className="text-[10px] text-gray-500">{formatWeekLabel(latestOg.week_start, latestOg.week_end)}</span>
                </a>
              )}

              {/* Soft hint that this link is a fixed snapshot */}
              <span className="text-[10px] text-gray-600 ml-1">
                You&apos;re viewing a fixed snapshot · click above for current week
              </span>
            </div>
          </div>
        )}
      </header>

      {/* Sprint WEEKLY.PUBLIC.MATCH-INTERNAL — main body mirrors the
          /reports/weekly internal layout: 6-card KPI grid + AI-written
          team brief with numbered tasks. Narrative + watchlist + priorities
          stay below for the long-form readers. */}
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">

        {/* Week heading */}
        <div>
          <h2 className="text-xl font-bold text-white">{weekLabel}</h2>
          <p className="text-xs text-gray-500 mt-0.5">Generated {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
        </div>

        {/* ── 6-card KPI grid: GSC row + GA4 row ─────────────────────────-- */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard
            icon="🖱️"
            label="Clicks"
            value={fmtNum(gsc.weekClicks)}
            pct={gsc.clicksPct ?? null}
            sub={gsc.prevWeekClicks != null ? `prev ${fmtNum(gsc.prevWeekClicks)}` : undefined}
          />
          <StatCard
            icon="👁️"
            label="Impressions"
            value={fmtNum(gsc.weekImpressions)}
            pct={gsc.impressionsPct ?? null}
            sub={gsc.avgPosition != null ? `avg pos ${gsc.avgPosition.toFixed(1)}` : undefined}
          />
          <StatCard
            icon="🎯"
            label="CTR"
            value={gsc.weekCtr != null ? `${gsc.weekCtr.toFixed(2)}%` : '—'}
            pct={gsc.ctrPct ?? null}
            sub={gsc.prevWeekCtr != null ? `prev ${gsc.prevWeekCtr.toFixed(2)}%` : undefined}
          />
          <StatCard
            icon="📈"
            label="Organic Sessions"
            value={fmtNum(ga4.weekSessions)}
            pct={ga4.sessionsPct ?? null}
            sub={ga4.prevWeekSessions != null ? `prev ${fmtNum(ga4.prevWeekSessions)}` : 'GA4 not connected'}
          />
          <StatCard
            icon="💰"
            label="Revenue"
            value={ga4.totalRevenue != null ? fmtUsd(ga4.totalRevenue) : '—'}
            pct={ga4.revenuePct ?? null}
            sub={ga4.prevRevenue != null ? `prev ${fmtUsd(ga4.prevRevenue)}` : undefined}
          />
          <StatCard
            icon="🛒"
            label="Purchases"
            value={ga4.totalPurchases != null ? fmtNum(ga4.totalPurchases) : '—'}
            pct={ga4.purchasesPct ?? null}
            sub={ga4.prevPurchases != null ? `prev ${fmtNum(ga4.prevPurchases)}` : undefined}
          />
        </div>

        {/* ── This Week — Team Brief (AI action plan, numbered cards) ─── */}
        {actionPlan && (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span className="text-base">📋</span>
                THIS WEEK — TEAM BRIEF
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700 ml-1">
                  {parsePlanItems(actionPlan).length} tasks
                </span>
              </h3>
              <span className="text-[10px] text-gray-600 uppercase tracking-wider">AI-WRITTEN</span>
            </div>
            <ol className="space-y-3">
              {parsePlanItems(actionPlan).map((item, i) => (
                <li key={i} className="flex gap-3 p-3 rounded-lg bg-gray-950/40 border border-gray-800/60">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-700 text-white text-xs font-bold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-white mb-1">{item.title}</p>
                    {item.detail && <p className="text-xs text-gray-400 leading-relaxed">{item.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* ── Executive summary (long-form narrative) ─────────────────── */}
        {narrative && (
          <section>
            <h3 className="text-sm font-bold text-white mb-3">Executive summary</h3>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-5 text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
              {narrative}
            </div>
          </section>
        )}

        {/* ── Tier Status (only when scoring has run) ─────────────────── */}
        {(tier.top3 != null || tier.top10 != null) && (
          <section>
            <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-base">🥇</span>Tier status
            </h3>
            <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
              <TierStat label="Top 3"        value={tier.top3 ?? 0}  delta={tier.top3Delta} />
              <TierStat label="Top 10"       value={tier.top10 ?? 0} delta={tier.top10Delta} />
              <TierStat label="Tier 1 avg"   value={tier.tier1AvgPos != null ? `#${tier.tier1AvgPos.toFixed(1)}` : '—'} />
              <TierStat label="Tier 2 avg"   value={tier.tier2AvgPos != null ? `#${tier.tier2AvgPos.toFixed(1)}` : '—'} />
            </div>
          </section>
        )}

        {/* ── Watch list (curatorial) ─────────────────────────────────── */}
        {watchList.length > 0 && (
          <section>
            <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <span className="text-base">⚠️</span>Watch list ({watchList.length})
            </h3>
            <ul className="space-y-2">
              {watchList.map((item, i) => (
                <li key={i} className="rounded-md border border-amber-700/30 bg-amber-500/5 p-3 text-sm text-gray-200">
                  {item}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Top movers (optional) ───────────────────────────────────── */}
        {(gsc.topGainers?.length || gsc.topLosers?.length) && (
          <section>
            <h3 className="text-sm font-bold text-white mb-3">Top movers</h3>
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

// ─── StatCard (matches /reports/weekly internal styling) ──────────────────
function StatCard({ icon, label, value, pct, sub }: {
  icon: string; label: string; value: string; pct?: number | null; sub?: string
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-start justify-between gap-2 mb-3">
        <span className="text-gray-500 text-xs font-semibold uppercase tracking-wider">{label}</span>
        <span className="text-base">{icon}</span>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-white">{value}</span>
        {pct != null && pctBadge(pct)}
      </div>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

function pctBadge(pct: number) {
  const isUp   = pct > 0
  const isDown = pct < 0
  const cls = isUp   ? 'text-emerald-300 bg-emerald-500/10 border-emerald-700/40'
            : isDown ? 'text-red-300     bg-red-500/10     border-red-700/40'
                     : 'text-gray-400    bg-gray-700/30    border-gray-600/40'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${cls}`}>
      {isUp ? '↑' : isDown ? '↓' : '·'}{Math.abs(pct).toFixed(0)}%
    </span>
  )
}

// ─── parsePlanItems — parse markdown numbered list into {title, detail} ──
function parsePlanItems(raw: string): Array<{ title: string; detail: string }> {
  if (!raw) return []
  // Split on lines starting with "1." / "2." / etc.; each block becomes one item.
  // Title = first line stripped of "N. **…**" wrapper; detail = remaining lines.
  const blocks = raw.split(/\n(?=\d+\.\s)/g).map(b => b.trim()).filter(Boolean)
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return { title: '', detail: '' }
    const first = lines[0]
    // Try "1. **Title** — detail" first
    const inline = first.match(/^\d+\.\s+\*\*(.+?)\*\*\s*[–—-]\s*(.+)$/)
    if (inline) {
      const moreDetail = lines.slice(1).join(' ').trim()
      return { title: inline[1].trim(), detail: (inline[2] + (moreDetail ? ' ' + moreDetail : '')).trim() }
    }
    // Fallback: "1. **Title**" (title only) → detail comes from following lines
    const titleOnly = first.match(/^\d+\.\s+\*\*(.+?)\*\*\s*$/)
    if (titleOnly) {
      return { title: titleOnly[1].trim(), detail: lines.slice(1).join(' ').trim() }
    }
    // Plain "1. detail" — title becomes empty, detail is the whole thing
    const plain = first.match(/^\d+\.\s+(.+)$/)
    if (plain) {
      return { title: plain[1].trim(), detail: lines.slice(1).join(' ').trim() }
    }
    return { title: first.replace(/\*\*/g, ''), detail: lines.slice(1).join(' ').trim() }
  }).filter(it => it.title || it.detail)
}

// ─── Mini components ────────────────────────────────────────────────────

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

function fmtUsd(n?: number | null): string {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`
  return `$${n.toFixed(0)}`
}

function trimPath(url: string): string {
  return url.replace(/^https?:\/\/[^/]+/, '').slice(0, 40)
}

function formatWeekLabel(start: string, end: string): string {
  const s = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const e = new Date(end).toLocaleDateString('en-US',   { month: 'short', day: 'numeric', year: 'numeric' })
  return `${s} – ${e}`
}
