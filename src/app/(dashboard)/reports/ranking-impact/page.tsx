'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BriefMeta {
  primary_keyword: string | null
  page:            string | null
  status:          string | null
  tyr_score:       number | null
}

interface Outcome {
  id:              string
  brief_id:        string
  page_url:        string
  primary_keyword: string | null
  published_at:    string | null
  pos_0:           number | null
  pos_30:          number | null
  pos_60:          number | null
  pos_90:          number | null
  clicks_0:        number | null
  clicks_30:       number | null
  clicks_60:       number | null
  clicks_90:       number | null
  impressions_0:   number | null
  impressions_30:  number | null
  impressions_60:  number | null
  impressions_90:  number | null
  snapshot_0_at:   string | null
  snapshot_30_at:  string | null
  snapshot_60_at:  string | null
  snapshot_90_at:  string | null
  seo_content_briefs: BriefMeta
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pathOnly(url: string | null): string {
  if (!url) return ''
  try { return new URL(url).pathname } catch { return url ?? '' }
}

function fmt(n: number | null): string {
  if (n === null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function pos(n: number | null): string {
  return n === null ? '—' : n.toFixed(1)
}

function daysAgo(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

// ── Position delta display ────────────────────────────────────────────────────

function PosDelta({ from, to }: { from: number | null; to: number | null }) {
  if (from === null || to === null) return <span className="text-gray-600">—</span>
  const delta = from - to  // positive = improved (lower position = better)
  if (Math.abs(delta) < 0.5) return <span className="text-gray-500">~</span>
  const color = delta > 0 ? 'text-green-400' : 'text-red-400'
  const sign  = delta > 0 ? '▲' : '▼'
  return <span className={`font-semibold text-xs ${color}`}>{sign}{Math.abs(delta).toFixed(1)}</span>
}

// ── Snapshot progress bar ─────────────────────────────────────────────────────

function SnapshotProgress({ outcome }: { outcome: Outcome }) {
  const checkpoints = [
    { label: 'Publish', taken: !!outcome.snapshot_0_at,  pos: outcome.pos_0  },
    { label: '+30d',    taken: !!outcome.snapshot_30_at, pos: outcome.pos_30 },
    { label: '+60d',    taken: !!outcome.snapshot_60_at, pos: outcome.pos_60 },
    { label: '+90d',    taken: !!outcome.snapshot_90_at, pos: outcome.pos_90 },
  ]
  const takenCount = checkpoints.filter(c => c.taken).length

  return (
    <div className="flex items-center gap-1">
      {checkpoints.map((c, i) => (
        <div key={i} className="flex flex-col items-center">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold border ${
            c.taken
              ? 'bg-green-700 border-green-500 text-white'
              : 'bg-gray-800 border-gray-700 text-gray-600'
          }`}>
            {c.taken ? '✓' : i + 1}
          </div>
          <span className="text-[8px] text-gray-600 mt-0.5">{c.label}</span>
        </div>
      ))}
      {takenCount < 4 && (
        <div className="ml-1 h-px flex-1 bg-gray-800 relative">
          <div
            className="absolute left-0 top-0 h-full bg-green-700"
            style={{ width: `${(takenCount / 4) * 100}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ── Position trend sparkline ──────────────────────────────────────────────────

function PositionSparkline({ outcome }: { outcome: Outcome }) {
  const points = [
    outcome.pos_0,
    outcome.pos_30,
    outcome.pos_60,
    outcome.pos_90,
  ]
  const valid = points.filter((p): p is number => p !== null)
  if (valid.length < 2) {
    return <span className="text-gray-700 text-xs italic">Not enough data</span>
  }

  const min  = Math.min(...valid)
  const max  = Math.max(...valid)
  const range = max - min || 1

  const W = 80, H = 28, pad = 3
  const xs = [0, 1, 2, 3]
  const plotPoints: { x: number; y: number; v: number }[] = []

  for (let i = 0; i < points.length; i++) {
    if (points[i] === null) continue
    const x = pad + (i / 3) * (W - pad * 2)
    // Lower position = better = higher on chart, so invert y
    const y = pad + ((points[i]! - min) / range) * (H - pad * 2)
    plotPoints.push({ x, y: H - y + pad, v: points[i]! })
  }

  if (plotPoints.length < 2) return null

  const pathD = plotPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const improved = plotPoints[plotPoints.length - 1].v < plotPoints[0].v
  const color = improved ? '#4ade80' : '#f87171'

  return (
    <svg width={W} height={H} className="overflow-visible">
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      {plotPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="2" fill={color} />
      ))}
    </svg>
  )
}

// ── Outcome row ───────────────────────────────────────────────────────────────

function OutcomeRow({
  outcome,
  onSnapshot,
  snapshotting,
}: {
  outcome: Outcome
  onSnapshot: (id: string) => Promise<void>
  snapshotting: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  const brief   = outcome.seo_content_briefs
  const title   = outcome.primary_keyword || brief?.primary_keyword || pathOnly(outcome.page_url)
  const path    = pathOnly(outcome.page_url)
  const age     = outcome.published_at ? daysAgo(outcome.published_at) : null
  const takenCount = [outcome.snapshot_0_at, outcome.snapshot_30_at, outcome.snapshot_60_at, outcome.snapshot_90_at].filter(Boolean).length

  // Overall movement: compare earliest to latest
  const firstPos = outcome.pos_0
  const lastPos  = outcome.pos_90 ?? outcome.pos_60 ?? outcome.pos_30 ?? outcome.pos_0
  const improved = firstPos !== null && lastPos !== null && lastPos < firstPos

  return (
    <>
      <tr
        className="border-b border-gray-800 hover:bg-gray-800/30 cursor-pointer transition"
        onClick={() => setExpanded(e => !e)}
      >
        <td className="py-3 px-4">
          <div>
            <p className="text-sm text-white font-medium truncate max-w-[200px]">{title}</p>
            <p className="text-[10px] text-gray-500 font-mono truncate">{path}</p>
          </div>
        </td>
        <td className="py-3 px-3 text-xs text-gray-400">
          {outcome.published_at
            ? <>{outcome.published_at}<br /><span className="text-gray-600">{age}d ago</span></>
            : '—'}
        </td>
        <td className="py-3 px-3">
          <PositionSparkline outcome={outcome} />
        </td>
        <td className="py-3 px-3 text-center">
          <span className={`text-sm font-bold ${firstPos !== null && firstPos <= 10 ? 'text-green-400' : firstPos !== null && firstPos <= 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
            {pos(outcome.pos_0)}
          </span>
        </td>
        <td className="py-3 px-3 text-center">
          <div className="flex items-center justify-center gap-1">
            <span className="text-sm text-gray-300">{pos(outcome.pos_30)}</span>
            <PosDelta from={outcome.pos_0} to={outcome.pos_30} />
          </div>
        </td>
        <td className="py-3 px-3 text-center">
          <div className="flex items-center justify-center gap-1">
            <span className="text-sm text-gray-300">{pos(outcome.pos_60)}</span>
            <PosDelta from={outcome.pos_0} to={outcome.pos_60} />
          </div>
        </td>
        <td className="py-3 px-3 text-center">
          <div className="flex items-center justify-center gap-1">
            <span className="text-sm text-gray-300">{pos(outcome.pos_90)}</span>
            <PosDelta from={outcome.pos_0} to={outcome.pos_90} />
          </div>
        </td>
        <td className="py-3 px-3">
          <SnapshotProgress outcome={outcome} />
        </td>
        <td className="py-3 px-3">
          {takenCount < 4 && (
            <button
              onClick={e => { e.stopPropagation(); onSnapshot(outcome.id) }}
              disabled={snapshotting === outcome.id}
              className="text-[10px] px-2 py-1 rounded-lg bg-gray-800 hover:bg-blue-700 text-gray-400 hover:text-white transition disabled:opacity-40"
            >
              {snapshotting === outcome.id ? '…' : '📸 Snap'}
            </button>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-gray-800 bg-gray-900/40">
          <td colSpan={9} className="px-6 py-4">
            <div className="grid grid-cols-4 gap-4">
              {[
                { label: 'At publish', pos: outcome.pos_0, clicks: outcome.clicks_0, impr: outcome.impressions_0, at: outcome.snapshot_0_at },
                { label: '+30 days',   pos: outcome.pos_30, clicks: outcome.clicks_30, impr: outcome.impressions_30, at: outcome.snapshot_30_at },
                { label: '+60 days',   pos: outcome.pos_60, clicks: outcome.clicks_60, impr: outcome.impressions_60, at: outcome.snapshot_60_at },
                { label: '+90 days',   pos: outcome.pos_90, clicks: outcome.clicks_90, impr: outcome.impressions_90, at: outcome.snapshot_90_at },
              ].map((cp, i) => (
                <div key={i} className={`rounded-xl border p-3 ${cp.at ? 'border-gray-700 bg-gray-800/50' : 'border-gray-800 bg-gray-900 opacity-50'}`}>
                  <p className="text-[10px] text-gray-500 font-semibold uppercase mb-2">{cp.label}</p>
                  {cp.at ? (
                    <>
                      <p className="text-lg font-bold text-white">{pos(cp.pos)}<span className="text-xs text-gray-500 ml-1">pos</span></p>
                      <p className="text-xs text-gray-400 mt-1">{fmt(cp.clicks)} clicks · {fmt(cp.impr)} impr</p>
                      <p className="text-[9px] text-gray-600 mt-1">Snapped {new Date(cp.at).toLocaleDateString('id-ID')}</p>
                    </>
                  ) : (
                    <p className="text-xs text-gray-600 italic">Not yet</p>
                  )}
                </div>
              ))}
            </div>
            {brief?.tyr_score != null && (
              <p className="text-[10px] text-gray-600 mt-3">Brief quality score: {brief.tyr_score}/100</p>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RankingImpactPage() {
  const [outcomes,     setOutcomes]     = useState<Outcome[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const [snapshotting, setSnapshotting] = useState<string | null>(null)
  const [filter,       setFilter]       = useState<'all' | 'improved' | 'declined' | 'pending'>('all')
  const [search,       setSearch]       = useState('')

  useEffect(() => {
    fetch('/api/brief-outcomes')
      .then(r => r.json())
      .then(d => {
        if (d.error) throw new Error(d.error)
        setOutcomes(d.outcomes ?? [])
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const handleSnapshot = useCallback(async (id: string) => {
    setSnapshotting(id)
    try {
      const res = await fetch('/api/brief-outcomes', {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ outcome_id: id }),
      })
      const data = await res.json()
      if (res.ok && data.checkpoint !== undefined) {
        setOutcomes(prev => prev.map(o => o.id === id ? {
          ...o,
          [`pos_${data.checkpoint}`]:         data.position,
          [`clicks_${data.checkpoint}`]:      data.clicks,
          [`impressions_${data.checkpoint}`]: data.impressions,
          [`snapshot_${data.checkpoint}_at`]: new Date().toISOString(),
        } : o))
      }
    } finally {
      setSnapshotting(null)
    }
  }, [])

  const filtered = outcomes.filter(o => {
    if (search) {
      const hay = [o.primary_keyword, o.page_url].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(search.toLowerCase())) return false
    }
    if (filter === 'improved') {
      const first = o.pos_0, last = o.pos_90 ?? o.pos_60 ?? o.pos_30
      return first !== null && last !== null && last < first
    }
    if (filter === 'declined') {
      const first = o.pos_0, last = o.pos_90 ?? o.pos_60 ?? o.pos_30
      return first !== null && last !== null && last > first
    }
    if (filter === 'pending') {
      return !o.snapshot_0_at || !o.snapshot_30_at || !o.snapshot_60_at || !o.snapshot_90_at
    }
    return true
  })

  // Summary stats
  const improvedCount = outcomes.filter(o => {
    const f = o.pos_0, l = o.pos_90 ?? o.pos_60 ?? o.pos_30
    return f !== null && l !== null && l < f
  }).length
  const pendingCount  = outcomes.filter(o => !o.snapshot_90_at).length

  return (
    <div className="p-6 space-y-6 text-white">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white">📈 Ranking Impact Tracker</h1>
        <p className="text-gray-400 text-sm mt-0.5">
          GSC position snapshots at publish · +30d · +60d · +90d for every published brief.
        </p>
      </div>

      {/* Stats */}
      {!loading && outcomes.length > 0 && (
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
            <p className="text-xs text-gray-400 mb-1">Tracked briefs</p>
            <p className="text-2xl font-bold text-white">{outcomes.length}</p>
          </div>
          <div className="bg-green-900/20 rounded-xl p-4 border border-green-800/40">
            <p className="text-xs text-gray-400 mb-1">Improved</p>
            <p className="text-2xl font-bold text-green-400">{improvedCount}</p>
            <p className="text-[10px] text-gray-500">position went up after publish</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
            <p className="text-xs text-gray-400 mb-1">Snapshots pending</p>
            <p className="text-2xl font-bold text-amber-400">{pendingCount}</p>
            <p className="text-[10px] text-gray-500">not all 4 checkpoints done</p>
          </div>
          <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
            <p className="text-xs text-gray-400 mb-1">Completed</p>
            <p className="text-2xl font-bold text-white">{outcomes.length - pendingCount}</p>
            <p className="text-[10px] text-gray-500">all 4 snapshots taken</p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex border border-gray-700 rounded-lg overflow-hidden text-sm">
          {([
            ['all',      `All (${outcomes.length})`],
            ['improved', `📈 Improved (${improvedCount})`],
            ['declined', '📉 Declined'],
            ['pending',  `⏳ Pending (${pendingCount})`],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`px-3 py-1.5 transition ${filter === k ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search keyword or page…"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none w-52"
        />
      </div>

      {/* Error / loading */}
      {error && <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>}
      {loading && <div className="bg-gray-800 rounded-xl h-32 animate-pulse" />}

      {/* Empty state */}
      {!loading && outcomes.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-2xl p-16 text-center">
          <p className="text-4xl mb-3">📊</p>
          <p className="text-white font-semibold text-lg mb-1">No published briefs tracked yet</p>
          <p className="text-gray-400 text-sm max-w-md mx-auto">
            When you mark a brief as published in the{' '}
            <a href="/content/writer-inbox" className="text-blue-400 hover:underline">Writer Inbox</a>{' '}
            or{' '}
            <a href="/content/briefs" className="text-blue-400 hover:underline">Brief Library</a>,
            it automatically appears here and we start tracking its ranking over 90 days.
          </p>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr>
                <th className="py-3 px-4 text-left text-xs font-semibold text-gray-400">Brief / Page</th>
                <th className="py-3 px-3 text-left text-xs font-semibold text-gray-400">Published</th>
                <th className="py-3 px-3 text-left text-xs font-semibold text-gray-400">Trend</th>
                <th className="py-3 px-3 text-center text-xs font-semibold text-gray-400">At pub</th>
                <th className="py-3 px-3 text-center text-xs font-semibold text-gray-400">+30d</th>
                <th className="py-3 px-3 text-center text-xs font-semibold text-gray-400">+60d</th>
                <th className="py-3 px-3 text-center text-xs font-semibold text-gray-400">+90d</th>
                <th className="py-3 px-3 text-left text-xs font-semibold text-gray-400">Snapshots</th>
                <th className="py-3 px-3 text-left text-xs font-semibold text-gray-400"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(o => (
                <OutcomeRow
                  key={o.id}
                  outcome={o}
                  onSnapshot={handleSnapshot}
                  snapshotting={snapshotting}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Help */}
      {!loading && outcomes.length > 0 && (
        <p className="text-[10px] text-gray-600">
          Position data is pulled from GSC (last 7-day average). ▲ green = improved, ▼ red = declined vs publish position.
          Click any row to see full checkpoint detail. Use 📸 Snap to manually trigger a snapshot.
        </p>
      )}
    </div>
  )
}
