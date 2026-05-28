'use client'

import { useEffect, useState } from 'react'

// ─── Content Economics ──────────────────────────────────────────────────────
// Lead time + cost per article. Direct answer to:
//   "Measure content population lead time (~10 mins benchmark)"
//   "DataForSEO cost breakdown"
//   "Cost saving vs manual"

interface LeadTime {
  avg: number | null
  p50: number | null
  p95: number | null
  n:   number
}

interface Response {
  window_days: number
  queue_stats: {
    total_rows:        number
    generated:         number
    uploaded:          number
    awaiting_token:    number
    failed:            number
    pending:           number
    lead_time_seconds: {
      created_to_generated:  LeadTime
      generated_to_uploaded: LeadTime
      created_to_uploaded:   LeadTime
    }
  }
  cost: {
    by_api: Array<{ api: string; calls: number; cost_usd: number }>
    total_cost_usd:               number
    total_api_calls:              number
    cost_per_article:             number
    manual_baseline_per_article:  number
    manual_baseline_total:        number
    savings_total:                number
    savings_pct:                  number
  }
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  if (seconds < 60)   return `${seconds.toFixed(0)}s`
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}min`
  return `${(seconds / 3600).toFixed(1)}h`
}

function fmtUSD(n: number): string {
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`
  if (n < 1)        return `$${n.toFixed(4)}`
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function ContentEconomicsPage() {
  const [days,    setDays]    = useState<7 | 30 | 90>(30)
  const [data,    setData]    = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res  = await fetch(`/api/reports/content-economics?days=${days}`)
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
          <h1 className="text-2xl font-bold text-white">⏱ Content Economics</h1>
          <p className="text-sm text-gray-400 mt-1">
            Lead time + cost per AI-generated article. Direct answer to &quot;how long + how much&quot; questions.
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
          {/* Hero */}
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-6">
            <p className="text-xs uppercase tracking-wide text-emerald-300 mb-1">Net savings vs manual baseline</p>
            <p className="text-4xl md:text-5xl font-bold text-white">
              {fmtUSD(data.cost.savings_total)}
              <span className="text-lg text-emerald-400 ml-3 font-normal">({data.cost.savings_pct}% reduction)</span>
            </p>
            <p className="text-sm text-gray-300 mt-2">
              <b>{data.queue_stats.generated}</b> articles generated · AI cost <b className="text-amber-300">{fmtUSD(data.cost.total_cost_usd)}</b> vs manual <b className="text-red-300">{fmtUSD(data.cost.manual_baseline_total)}</b>
            </p>
          </div>

          {/* Lead time KPIs */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-sm font-semibold text-white mb-3">⏱ Lead time (BDT trigger → CMS live)</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <LeadTimeCard label="BDT trigger → AI generated"  data={data.queue_stats.lead_time_seconds.created_to_generated} target="≤5min" />
              <LeadTimeCard label="AI generated → CMS uploaded" data={data.queue_stats.lead_time_seconds.generated_to_uploaded} target="≤1min" />
              <LeadTimeCard label="End-to-end (trigger → live)" data={data.queue_stats.lead_time_seconds.created_to_uploaded}   target="≤10min" highlight />
            </div>
          </div>

          {/* Queue status */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-sm font-semibold text-white mb-3">📦 Queue snapshot (current window)</h2>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
              <StatusCount label="Total"          n={data.queue_stats.total_rows}      tone="gray" />
              <StatusCount label="Generated"      n={data.queue_stats.generated}       tone="blue" />
              <StatusCount label="Uploaded"       n={data.queue_stats.uploaded}        tone="green" />
              <StatusCount label="Pending"        n={data.queue_stats.pending}         tone="gray" />
              <StatusCount label="Awaiting token" n={data.queue_stats.awaiting_token}  tone="amber" />
              <StatusCount label="Failed"         n={data.queue_stats.failed}          tone="red" />
            </div>
          </div>

          {/* Cost breakdown */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
              <h2 className="text-sm font-semibold text-white mb-3">💸 Cost per API</h2>
              <table className="w-full text-sm">
                <thead className="text-[10px] uppercase text-gray-500 border-b border-gray-800">
                  <tr>
                    <th className="text-left pb-2">API</th>
                    <th className="text-right pb-2">Calls</th>
                    <th className="text-right pb-2">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.cost.by_api.sort((a, b) => b.cost_usd - a.cost_usd).map(c => (
                    <tr key={c.api} className="border-b border-gray-800/40">
                      <td className="py-1.5 text-white capitalize">{c.api}</td>
                      <td className="py-1.5 text-right text-gray-300">{c.calls.toLocaleString()}</td>
                      <td className="py-1.5 text-right text-amber-300">{fmtUSD(c.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="pt-2 font-semibold text-white">Total</td>
                    <td className="pt-2 text-right text-gray-300">{data.cost.total_api_calls.toLocaleString()}</td>
                    <td className="pt-2 text-right font-bold text-amber-300">{fmtUSD(data.cost.total_cost_usd)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
              <h2 className="text-sm font-semibold text-white mb-3">📊 Per-article math</h2>
              <div className="space-y-3 text-sm">
                <Row label="AI cost / article"        value={fmtUSD(data.cost.cost_per_article)} tone="amber" />
                <Row label="Manual baseline / article" value={fmtUSD(data.cost.manual_baseline_per_article)} tone="red" />
                <Row label="Savings / article"         value={fmtUSD(data.cost.manual_baseline_per_article - data.cost.cost_per_article)} tone="emerald" highlight />
                <p className="text-[10px] text-gray-500 pt-2 border-t border-gray-800">
                  Manual baseline: 1h × $20/hr writing + 15min × $15/hr CMS upload = $23.75/article.
                  AI baseline counts DataForSEO + Anthropic + FireCrawl combined.
                </p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function LeadTimeCard({ label, data, target, highlight }: { label: string; data: LeadTime; target: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border ${highlight ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-gray-800 bg-gray-950'} p-4`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-white mt-1">{fmtDuration(data.avg)}</p>
      <p className="text-[10px] text-gray-400">avg · target {target}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]">
        <span className="text-gray-500">p50: <b className="text-gray-300">{fmtDuration(data.p50)}</b></span>
        <span className="text-gray-500">p95: <b className="text-gray-300">{fmtDuration(data.p95)}</b></span>
      </div>
      <p className="text-[10px] text-gray-600 mt-1">{data.n.toLocaleString()} samples</p>
    </div>
  )
}

function StatusCount({ label, n, tone }: { label: string; n: number; tone: 'gray' | 'blue' | 'green' | 'amber' | 'red' }) {
  const colors = {
    gray:  'border-gray-800       bg-gray-900',
    blue:  'border-blue-700/40    bg-blue-500/5',
    green: 'border-emerald-700/40 bg-emerald-500/5',
    amber: 'border-amber-700/40   bg-amber-500/5',
    red:   'border-red-700/40     bg-red-500/5',
  }[tone]
  return (
    <div className={`rounded-md border ${colors} p-2`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-bold text-white mt-0.5">{n.toLocaleString()}</p>
    </div>
  )
}

function Row({ label, value, tone, highlight }: { label: string; value: string; tone: 'amber' | 'red' | 'emerald'; highlight?: boolean }) {
  const colors = { amber: 'text-amber-300', red: 'text-red-300', emerald: 'text-emerald-300' }[tone]
  return (
    <div className={`flex items-center justify-between ${highlight ? 'border-t border-gray-800 pt-2 mt-2' : ''}`}>
      <span className="text-gray-300">{label}</span>
      <span className={`font-bold ${colors}`}>{value}</span>
    </div>
  )
}
