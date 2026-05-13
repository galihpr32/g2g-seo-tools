'use client'

import { useEffect, useState } from 'react'

// ─── Agent Performance Report (Executive view) ──────────────────────────────
// Shows the magnitude story: hours saved, $ saved vs manual, content shipped,
// cost. Used for weekly stakeholder updates + on-demand status checks.
//
// Headline metric: NET VALUE (savings - cost) — usually well into the $1000s
// per week because automation replaces hours of analyst work.

interface AgentBlock {
  runs:              number
  opportunities?:    number
  briefs_generated?: number
  auto_approved?:    number
  prospects_found?:  number
  reviews?:          number
  needs_review?:     number
  news_articles?:    number
  game_extractions?: number
  success_rate?:     number
}

interface Metrics {
  window_days: number
  agents: {
    heimdall:  AgentBlock
    odin:      AgentBlock
    loki:      AgentBlock
    bragi:     AgentBlock
    hermod:    AgentBlock
    tyr:       AgentBlock
    bifrost:   AgentBlock
  }
  content: {
    briefs_total:             number
    briefs_published:         number
    product_content:          number
    product_content_uploaded: number
    opportunities_total:      number
  }
  cost: {
    dataforseo: number; anthropic: number; firecrawl: number; other: number; total: number;
    api_calls_total: number
  }
  savings: {
    briefs: number; product_content: number; cms_upload: number;
    keyword_research: number; news_monitoring: number; total: number; hours_saved: number
  }
  net_value: number
}

interface Response { current: Metrics; previous: Metrics; deltas: Record<string, number | null> }

function fmtUSD(n: number): string {
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`
  return `$${n.toLocaleString()}`
}

function fmtPct(n: number | null): string {
  if (n === null) return '↑ new'
  if (n > 0)  return `↑ ${n}%`
  if (n < 0)  return `↓ ${Math.abs(n)}%`
  return '→ 0%'
}

function pctTone(n: number | null, inverse = false): string {
  if (n === null || n === 0) return 'text-gray-400'
  const up = n > 0
  const good = inverse ? !up : up
  return good ? 'text-emerald-400' : 'text-red-400'
}

export default function AgentPerformanceReport() {
  const [days,   setDays]   = useState<7 | 30 | 90>(7)
  const [data,   setData]   = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,  setError]  = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res  = await fetch(`/api/reports/agent-performance?days=${days}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'fetch failed')
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [days])

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🤖 Agent Performance Report</h1>
          <p className="text-sm text-gray-400 mt-1">
            Executive snapshot: hours + dollars saved by the AI agents vs manual baseline.
            <span className="ml-2 text-gray-500">Manual labour costs estimated at $20-25/hr.</span>
          </p>
        </div>
        <div className="flex items-center gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          {([7, 30, 90] as const).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                days === d ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Last {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}
      {error   && <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-300">⚠ {error}</div>}

      {data && (
        <>
          {/* Hero block — the headline number */}
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-6">
            <p className="text-xs uppercase tracking-wide text-emerald-300 mb-1">Net value over last {data.current.window_days} day(s)</p>
            <p className="text-4xl md:text-5xl font-bold text-white">
              {fmtUSD(data.current.net_value)}
            </p>
            <p className="text-sm text-gray-300 mt-2">
              <b className="text-emerald-400">{fmtUSD(data.current.savings.total)}</b> saved vs manual
              <span className="text-gray-500"> · </span>
              <b className="text-amber-300">{fmtUSD(data.current.cost.total)}</b> API cost
              <span className="text-gray-500"> · </span>
              <b className="text-blue-300">{data.current.savings.hours_saved}h</b> analyst hours saved
            </p>
            {data.deltas.savings_pct !== undefined && (
              <p className="text-xs text-gray-400 mt-2">
                vs previous {data.current.window_days}d:
                <span className={`ml-1 ${pctTone(data.deltas.savings_pct)}`}>{fmtPct(data.deltas.savings_pct)}</span> savings
                <span className="text-gray-500"> · </span>
                <span className={`ml-1 ${pctTone(data.deltas.cost_pct, true)}`}>{fmtPct(data.deltas.cost_pct)}</span> cost
              </p>
            )}
          </div>

          {/* Content output KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi label="Briefs generated"   value={data.current.content.briefs_total}             delta={data.deltas.briefs_pct} tone="blue" />
            <Kpi label="Product content"    value={data.current.content.product_content}          delta={data.deltas.content_pct} tone="amber" />
            <Kpi label="CMS uploads"        value={data.current.content.product_content_uploaded} delta={data.deltas.cms_upload_pct} tone="green" />
            <Kpi label="Opportunities"      value={data.current.content.opportunities_total}      delta={data.deltas.opportunities_pct} tone="purple" />
          </div>

          {/* Per-agent breakdown */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-lg font-semibold text-white mb-3">Per-Agent Activity</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase text-gray-500 border-b border-gray-800">
                  <tr>
                    <th className="text-left px-2 py-2">Agent</th>
                    <th className="text-right px-2 py-2">Runs</th>
                    <th className="text-right px-2 py-2">Output</th>
                    <th className="text-right px-2 py-2">Success Rate</th>
                    <th className="text-left px-2 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  <AgentRow name="🛡 Heimdall" runs={data.current.agents.heimdall.runs} output={`${data.current.agents.heimdall.opportunities ?? 0} signals`}      rate={data.current.agents.heimdall.success_rate} notes="Ranking drop detector" />
                  <AgentRow name="👁 Odin"     runs={data.current.agents.odin.runs}     output={`${data.current.agents.odin.opportunities ?? 0} trends`}            rate={data.current.agents.odin.success_rate}     notes="Steam + DataForSEO trend monitor" />
                  <AgentRow name="🔮 Loki"     runs={data.current.agents.loki.runs}     output={`${data.current.agents.loki.opportunities ?? 0} keyword gaps`}      rate={data.current.agents.loki.success_rate}     notes="Competitor keyword gap finder" />
                  <AgentRow name="✍ Bragi"    runs={data.current.agents.bragi.runs}    output={`${data.current.agents.bragi.briefs_generated ?? 0} briefs (${data.current.agents.bragi.auto_approved ?? 0} auto-approved)`} rate={data.current.agents.bragi.success_rate} notes="AI content brief writer" />
                  <AgentRow name="🤝 Hermod"   runs={data.current.agents.hermod.runs}   output={`${data.current.agents.hermod.prospects_found ?? 0} prospects`}      rate={data.current.agents.hermod.success_rate}    notes="Outreach prospect finder" />
                  <AgentRow name="⚖ Tyr"      runs={data.current.agents.tyr.reviews ?? 0}  output={`${data.current.agents.tyr.auto_approved ?? 0} auto-approved · ${data.current.agents.tyr.needs_review ?? 0} needs review`} rate={null} notes="Brief quality reviewer" />
                  <AgentRow name="📰 Bifrost"  runs={data.current.agents.bifrost.runs}   output={`${data.current.agents.bifrost.news_articles ?? 0} articles · ${data.current.agents.bifrost.game_extractions ?? 0} games`} rate={null} notes="Gaming news listener" />
                </tbody>
              </table>
            </div>
          </div>

          {/* Savings breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
              <h2 className="text-sm font-semibold text-white mb-3">💰 Savings breakdown</h2>
              <div className="space-y-1.5 text-sm">
                <SavingsRow label="Briefs (4h × $25)"           amount={data.current.savings.briefs} />
                <SavingsRow label="Product content (1h × $20)"  amount={data.current.savings.product_content} />
                <SavingsRow label="CMS uploads (15min × $15)"    amount={data.current.savings.cms_upload} />
                <SavingsRow label="Keyword research (2h × $25)"  amount={data.current.savings.keyword_research} />
                <SavingsRow label="News monitoring (1h/day × $25)" amount={data.current.savings.news_monitoring} />
                <div className="border-t border-gray-800 pt-2 mt-2 flex items-center justify-between">
                  <span className="font-semibold text-white">Total savings</span>
                  <span className="font-bold text-emerald-400">{fmtUSD(data.current.savings.total)}</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
              <h2 className="text-sm font-semibold text-white mb-3">💸 API cost breakdown</h2>
              <div className="space-y-1.5 text-sm">
                <SavingsRow label="DataForSEO" amount={data.current.cost.dataforseo} tone="amber" />
                <SavingsRow label="Anthropic"  amount={data.current.cost.anthropic}  tone="amber" />
                <SavingsRow label="FireCrawl"  amount={data.current.cost.firecrawl}  tone="amber" />
                <SavingsRow label="Other"      amount={data.current.cost.other}      tone="amber" />
                <div className="border-t border-gray-800 pt-2 mt-2 flex items-center justify-between">
                  <span className="font-semibold text-white">Total cost</span>
                  <span className="font-bold text-amber-300">{fmtUSD(data.current.cost.total)}</span>
                </div>
                <p className="text-[10px] text-gray-500 mt-1">{data.current.cost.api_calls_total.toLocaleString()} total API calls</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, delta, tone }: { label: string; value: number; delta?: number | null; tone: 'blue' | 'amber' | 'green' | 'purple' }) {
  const colors = {
    blue:   'border-blue-700/40   bg-blue-500/5   text-blue-300',
    amber:  'border-amber-700/40  bg-amber-500/5  text-amber-300',
    green:  'border-green-700/40  bg-green-500/5  text-green-300',
    purple: 'border-purple-700/40 bg-purple-500/5 text-purple-300',
  }[tone]
  return (
    <div className={`rounded-lg border ${colors} p-4`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{value.toLocaleString()}</p>
      {delta != null && (
        <p className={`text-[10px] mt-0.5 ${pctTone(delta)}`}>{fmtPct(delta)} vs prev</p>
      )}
    </div>
  )
}

function AgentRow({ name, runs, output, rate, notes }: { name: string; runs: number; output: string; rate?: number | null; notes: string }) {
  return (
    <tr className="border-b border-gray-800/40">
      <td className="px-2 py-2 text-white">{name}</td>
      <td className="px-2 py-2 text-right text-gray-300">{runs.toLocaleString()}</td>
      <td className="px-2 py-2 text-right text-gray-300">{output}</td>
      <td className="px-2 py-2 text-right">
        {rate != null ? (
          <span className={rate >= 90 ? 'text-emerald-400' : rate >= 70 ? 'text-amber-300' : 'text-red-400'}>{rate}%</span>
        ) : <span className="text-gray-600">—</span>}
      </td>
      <td className="px-2 py-2 text-xs text-gray-500">{notes}</td>
    </tr>
  )
}

function SavingsRow({ label, amount, tone }: { label: string; amount: number; tone?: 'amber' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={tone === 'amber' ? 'text-amber-300' : 'text-emerald-300'}>{fmtUSD(amount)}</span>
    </div>
  )
}
