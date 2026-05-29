'use client'

// Sprint FORSETI.DASH.WIDGET — Community Response block on /dashboard.
// Client component to keep SSR page lean; fetches from /api/forseti/stats
// on mount. Skeleton until loaded.

import Link from 'next/link'
import { useEffect, useState } from 'react'

interface Stats {
  spotted_this_week:   number
  responded:           number
  response_rate_pct:   number
  sev4plus_pending:    number
  avg_response_time_h: number | null
  resolved_this_week:  number
}

export default function ForsetiWidget() {
  const [stats,   setStats]   = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/forseti/stats')
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) setErr(data.error ?? 'Failed')
        else setStats(data)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] uppercase tracking-wider text-purple-400 font-bold">⚖ Community Response (Forseti)</p>
        </div>
        <p className="text-xs text-gray-500 italic">Loading…</p>
      </div>
    )
  }

  if (err || !stats) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-[10px] uppercase tracking-wider text-purple-400 font-bold mb-2">⚖ Community Response</p>
        <p className="text-xs text-gray-500">
          {err ? `Error: ${err}` : 'No data yet. Configure subreddits to start tracking.'}
        </p>
        <Link href="/forseti/settings" className="text-[11px] text-purple-300 hover:text-purple-200 mt-1 inline-block">→ Settings</Link>
      </div>
    )
  }

  const noActivity = stats.spotted_this_week === 0
  const sevAlert   = stats.sev4plus_pending > 0

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[10px] uppercase tracking-wider text-purple-400 font-bold">⚖ Community Response (Forseti)</p>
        <Link href="/forseti" className="text-[10px] text-gray-500 hover:text-purple-300">View queue →</Link>
      </div>
      {noActivity ? (
        <p className="text-xs text-gray-500 italic">No threads in the last 7 days.</p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Mini label="Spotted 7d"     value={stats.spotted_this_week}  tone="gray" />
          <Mini label="Responded"      value={`${stats.responded} (${stats.response_rate_pct}%)`} tone="blue" />
          <Mini label="Avg resp time"  value={stats.avg_response_time_h == null ? '—' : `${stats.avg_response_time_h}h`} tone="gray" />
          <Mini label="Sev-4+ pending" value={stats.sev4plus_pending} tone={sevAlert ? 'red' : 'gray'} />
        </div>
      )}
      {sevAlert && (
        <p className="text-[11px] text-red-300 mt-2">
          ⚠ {stats.sev4plus_pending} high-severity thread{stats.sev4plus_pending === 1 ? '' : 's'} still need response.
        </p>
      )}
    </div>
  )
}

function Mini({ label, value, tone }: { label: string; value: number | string; tone: 'gray' | 'blue' | 'red' }) {
  const colors = {
    gray: 'text-gray-200',
    blue: 'text-blue-300',
    red:  'text-red-300',
  }[tone]
  return (
    <div className="bg-gray-950/30 border border-gray-800 rounded-lg p-2.5">
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`text-lg font-bold ${colors} mt-0.5`}>{value}</p>
    </div>
  )
}
