'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── AI Rollout Impact (Before/After ranking dashboard) ─────────────────────
// Shows ranking deltas per tier product between BASELINE snapshot and
// LATEST snapshot. Used to answer "did the AI rollout actually move rankings?"

interface KeywordDelta {
  keyword:      string
  market:       string
  baseline_pos: number | null
  latest_pos:   number | null
  pos_change:   number | null
  trend:        'improved' | 'declined' | 'unchanged' | 'new' | 'lost'
}

interface ProductDelta {
  product_id:       string
  product_name:     string
  category:         string | null
  tier:             number
  url:              string | null
  keywords_tracked: number
  avg_baseline_pos: number | null
  avg_latest_pos:   number | null
  avg_pos_change:   number | null
  improved:         number
  declined:         number
  unchanged:        number
  new_rankings:     number
  lost_rankings:    number
  health:           'winning' | 'mixed' | 'losing'
  keyword_details:  KeywordDelta[]
}

interface ImpactResponse {
  summary: {
    products_with_data: number
    products_winning:   number
    products_mixed:     number
    products_losing:    number
    keywords_improved:  number
    keywords_declined:  number
    keywords_unchanged: number
    keywords_new:       number
    keywords_lost:      number
    baseline_date:      string | null
    latest_date:        string | null
  }
  products: ProductDelta[]
  message?: string
}

export default function RolloutImpactPage() {
  const [data,     setData]     = useState<ImpactResponse | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const res  = await fetch('/api/reports/rollout-impact')
        const json = await res.json() as ImpactResponse
        if (!res.ok) throw new Error((json as unknown as { error?: string }).error ?? 'fetch failed')
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">📈 AI Rollout Impact</h1>
          <p className="text-sm text-gray-400 mt-1">
            Ranking deltas per tier product between baseline snapshot and latest.
            Direct answer to &quot;did the AI rollout actually move rankings?&quot;
          </p>
          {data?.summary?.baseline_date && (
            <p className="text-xs text-gray-500 mt-1">
              Comparing <b className="text-amber-300">{data.summary.baseline_date}</b> → <b className="text-emerald-300">{data.summary.latest_date}</b>
            </p>
          )}
        </div>
        <Link href="/priority-products" className="px-3 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm rounded-lg transition border border-gray-700">
          🎯 Priority Products →
        </Link>
      </div>

      {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}
      {error   && <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-300">⚠ {error}</div>}

      {data && data.message && (
        <div className="rounded-lg border border-amber-700/40 bg-amber-500/5 p-4 text-sm text-amber-200">
          ⚠ {data.message}
        </div>
      )}

      {data && data.products.length > 0 && (
        <>
          {/* Headline summary */}
          <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-transparent p-6">
            <p className="text-xs uppercase tracking-wide text-emerald-300 mb-1">Product-level outcome</p>
            <p className="text-3xl md:text-4xl font-bold text-white">
              {data.summary.products_winning} winning · {data.summary.products_mixed} mixed · {data.summary.products_losing} losing
            </p>
            <p className="text-sm text-gray-300 mt-2">
              Across <b>{data.summary.products_with_data}</b> tier products with snapshot history.
            </p>
          </div>

          {/* Keyword-level KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Kpi label="Improved"   value={data.summary.keywords_improved} tone="green" />
            <Kpi label="Declined"   value={data.summary.keywords_declined} tone="red" />
            <Kpi label="Unchanged"  value={data.summary.keywords_unchanged} tone="gray" />
            <Kpi label="New rank"   value={data.summary.keywords_new} tone="blue" />
            <Kpi label="Lost rank"  value={data.summary.keywords_lost} tone="amber" />
          </div>

          {/* Per-product list */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Per-product breakdown</h2>
              <p className="text-[10px] text-gray-500">Click row to expand keyword detail</p>
            </div>
            <div>
              {data.products.map(p => {
                const isOpen = expanded.has(p.product_id)
                return (
                  <div key={p.product_id} className="border-b border-gray-800/40">
                    <button
                      onClick={() => toggle(p.product_id)}
                      className="w-full px-4 py-3 hover:bg-gray-800/30 transition text-left"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <HealthBadge health={p.health} />
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${p.tier === 1 ? 'bg-amber-600 text-white' : 'bg-blue-600 text-white'}`}>T{p.tier}</span>
                          <span className="text-white text-sm font-medium truncate">{p.product_name}</span>
                          <span className="text-[10px] text-gray-500">{p.category}</span>
                        </div>
                        <div className="text-xs text-gray-300 flex items-center gap-4">
                          <span>
                            Avg pos: <b className="text-white">#{p.avg_baseline_pos ?? '—'}</b> → <b className="text-white">#{p.avg_latest_pos ?? '—'}</b>
                            {p.avg_pos_change != null && (
                              <span className={`ml-1 font-bold ${p.avg_pos_change > 0 ? 'text-emerald-400' : p.avg_pos_change < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                                ({p.avg_pos_change > 0 ? '+' : ''}{p.avg_pos_change})
                              </span>
                            )}
                          </span>
                          <span className="text-gray-500">
                            <span className="text-emerald-400">{p.improved}</span> / <span className="text-red-400">{p.declined}</span> / <span className="text-gray-400">{p.unchanged}</span>
                          </span>
                          <span className="text-gray-500">{isOpen ? '▾' : '▸'}</span>
                        </div>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="px-4 pb-4 bg-gray-950/40">
                        <table className="w-full text-xs">
                          <thead className="text-[10px] uppercase text-gray-500">
                            <tr>
                              <th className="text-left py-1.5">Keyword</th>
                              <th className="text-left py-1.5">Market</th>
                              <th className="text-right py-1.5">Baseline</th>
                              <th className="text-right py-1.5">Latest</th>
                              <th className="text-right py-1.5">Change</th>
                              <th className="text-left py-1.5">Trend</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.keyword_details.map((k, i) => (
                              <tr key={i} className="border-t border-gray-800/40">
                                <td className="py-1.5 text-white">{k.keyword}</td>
                                <td className="py-1.5 text-gray-400">{k.market}</td>
                                <td className="py-1.5 text-right text-gray-300">{k.baseline_pos ? `#${k.baseline_pos}` : '—'}</td>
                                <td className="py-1.5 text-right text-gray-300">{k.latest_pos ? `#${k.latest_pos}` : '—'}</td>
                                <td className={`py-1.5 text-right font-bold ${k.pos_change != null && k.pos_change > 0 ? 'text-emerald-400' : k.pos_change != null && k.pos_change < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                                  {k.pos_change != null ? (k.pos_change > 0 ? `+${k.pos_change}` : k.pos_change) : '—'}
                                </td>
                                <td className="py-1.5 text-left text-[10px]">
                                  <TrendChip trend={k.trend} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function HealthBadge({ health }: { health: 'winning' | 'mixed' | 'losing' }) {
  const map = {
    winning: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    mixed:   'bg-amber-500/15   text-amber-300   border-amber-500/30',
    losing:  'bg-red-500/15     text-red-300     border-red-500/30',
  }
  const icon = { winning: '✓', mixed: '~', losing: '✗' }[health]
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${map[health]}`}>{icon} {health}</span>
}

function TrendChip({ trend }: { trend: KeywordDelta['trend'] }) {
  const map = {
    improved:  { color: 'text-emerald-300', label: '↑ improved' },
    declined:  { color: 'text-red-300',     label: '↓ declined' },
    unchanged: { color: 'text-gray-400',    label: '→ unchanged' },
    new:       { color: 'text-blue-300',    label: '✦ new' },
    lost:      { color: 'text-amber-300',   label: '✗ lost' },
  }[trend]
  return <span className={map.color}>{map.label}</span>
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: 'green' | 'red' | 'gray' | 'blue' | 'amber' }) {
  const colors = {
    green: 'border-emerald-700/40 bg-emerald-500/5',
    red:   'border-red-700/40     bg-red-500/5',
    gray:  'border-gray-800       bg-gray-900',
    blue:  'border-blue-700/40    bg-blue-500/5',
    amber: 'border-amber-700/40   bg-amber-500/5',
  }[tone]
  return (
    <div className={`rounded-lg border ${colors} p-3`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-2xl font-bold text-white mt-0.5">{value.toLocaleString()}</p>
    </div>
  )
}
