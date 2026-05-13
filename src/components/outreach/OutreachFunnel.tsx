'use client'

/**
 * OutreachFunnel — horizontal-bar funnel chart of prospect → sent → replied
 * → agreed → live, with conversion rate labels between stages.
 *
 * Pulls from /api/outreach/funnel. Dropped at the top of /outreach to give
 * Specialist 2 + Head a quick "are we improving conversion?" pulse.
 */

import { useEffect, useState } from 'react'

interface FunnelStats {
  stats: {
    discovered: number
    sent:       number
    replied:    number
    agreed:     number
    live:       number
  }
  rates: {
    sentRate:    number
    replyRate:   number
    agreedRate:  number
    liveRate:    number
    overallRate: number
  }
  days: number
}

const STAGES: Array<{ key: 'discovered' | 'sent' | 'replied' | 'agreed' | 'live'; label: string; color: string }> = [
  { key: 'discovered', label: 'Discovered', color: 'bg-gray-600'  },
  { key: 'sent',       label: 'Sent',       color: 'bg-blue-600'  },
  { key: 'replied',    label: 'Replied',    color: 'bg-amber-600' },
  { key: 'agreed',     label: 'Agreed',     color: 'bg-purple-600'},
  { key: 'live',       label: 'Live',       color: 'bg-green-600' },
]

const RATE_LABELS: Array<{ key: 'sentRate' | 'replyRate' | 'agreedRate' | 'liveRate'; label: string }> = [
  { key: 'sentRate',   label: '→ Sent rate'    },
  { key: 'replyRate',  label: '→ Reply rate'   },
  { key: 'agreedRate', label: '→ Agreed rate'  },
  { key: 'liveRate',   label: '→ Live rate'    },
]

export default function OutreachFunnel({ defaultDays = 90 }: { defaultDays?: number }) {
  const [days, setDays]   = useState(defaultDays)
  const [data, setData]   = useState<FunnelStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true); setError(null)
    fetch(`/api/outreach/funnel?days=${days}`)
      .then(r => r.json())
      .then(d => {
        if (!d.ok) throw new Error(d.error ?? 'Failed')
        setData(d as FunnelStats)
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [days])

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">📊 Outreach Funnel</h2>
          <p className="text-[11px] text-gray-500">Prospect → Sent → Replied → Agreed → Live</p>
        </div>
        <div className="flex border border-gray-700 rounded-lg overflow-hidden text-xs">
          {[30, 90, 180].map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 transition ${days === d ? 'bg-amber-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </header>

      {loading && <p className="text-xs text-gray-500 text-center py-6">Loading…</p>}
      {error && <p className="text-xs text-red-400 text-center py-6">⚠️ {error}</p>}
      {data && data.stats.discovered === 0 && (
        <p className="text-xs text-gray-600 italic text-center py-6">
          No outreach prospects in the last {days} days.
        </p>
      )}

      {data && data.stats.discovered > 0 && (
        <>
          <div className="space-y-2">
            {STAGES.map((s, i) => {
              const value = data.stats[s.key]
              const max = data.stats.discovered || 1
              const pct = (value / max) * 100
              return (
                <div key={s.key} className="flex items-center gap-3 text-xs">
                  <span className="w-24 text-gray-400">{s.label}</span>
                  <div className="flex-1 h-7 bg-gray-800/60 rounded relative overflow-hidden">
                    <div className={`h-full ${s.color}`} style={{ width: `${pct}%` }} />
                    <span className="absolute inset-0 flex items-center px-2 text-white font-semibold">
                      {value} <span className="text-gray-300 font-normal ml-2">({pct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  {i < STAGES.length - 1 && (
                    <span className="w-28 text-right text-[10px] text-gray-500">
                      {RATE_LABELS[i].label}: <span className="text-amber-300 font-medium">{data.rates[RATE_LABELS[i].key]}%</span>
                    </span>
                  )}
                  {i === STAGES.length - 1 && (
                    <span className="w-28 text-right text-[10px] text-gray-500">
                      Overall: <span className="text-green-300 font-medium">{data.rates.overallRate}%</span>
                    </span>
                  )}
                </div>
              )
            })}
          </div>
          <p className="text-[10px] text-gray-600 mt-4 italic">
            Healthy reply rate ≥15%. Agreed rate ≥30%. Live rate (agreed → live) shows execution discipline.
          </p>
        </>
      )}
    </section>
  )
}
