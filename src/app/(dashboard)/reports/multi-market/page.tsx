'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Summary {
  market_a: string
  market_b: string
  date_range: string
  total_clicks_a: number
  total_clicks_b: number
  total_impr_a: number
  total_impr_b: number
  avg_position_a: number
  avg_position_b: number
  queries_total: number
  queries_both: number
  queries_a_only: number
  queries_b_only: number
  content_gaps_a: number
  content_gaps_b: number
  opportunities: number
}

interface QueryRow {
  query: string
  a_clicks: number
  a_impressions: number
  a_position: number | null
  b_clicks: number
  b_impressions: number
  b_position: number | null
  presence: 'both' | 'a_only' | 'b_only'
  position_diff: number | null
}

interface ContentGap {
  url: string
  path: string
  clicks: number
  impressions: number
  gap_type: 'a_only' | 'b_only'
}

interface Opportunity {
  query: string
  weak_market: 'a' | 'b'
  weak_position: number
  strong_position: number
  position_gap: number
  impressions: number
  clicks: number
}

interface ApiData {
  summary: Summary
  queries: QueryRow[]
  contentGaps: ContentGap[]
  opportunities: Opportunity[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MARKET_LABELS: Record<string, { label: string; flag: string }> = {
  usa: { label: 'US',        flag: '🇺🇸' },
  idn: { label: 'Indonesia', flag: '🇮🇩' },
  gbr: { label: 'UK',        flag: '🇬🇧' },
  aus: { label: 'Australia', flag: '🇦🇺' },
  sgp: { label: 'Singapore', flag: '🇸🇬' },
  mys: { label: 'Malaysia',  flag: '🇲🇾' },
  phl: { label: 'Philippines', flag: '🇵🇭' },
  tha: { label: 'Thailand',  flag: '🇹🇭' },
  can: { label: 'Canada',    flag: '🇨🇦' },
  deu: { label: 'Germany',   flag: '🇩🇪' },
}

const DAYS_OPTIONS = [
  { label: '30d', value: 30 },
  { label: '90d', value: 90 },
  { label: '180d', value: 180 },
]

function fmt(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n) }
function pos(n: number | null) { return n === null ? '—' : n.toFixed(1) }

function marketLabel(code: string) {
  const m = MARKET_LABELS[code]
  return m ? `${m.flag} ${m.label}` : code.toUpperCase()
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="bg-gray-800 rounded-xl p-4 border border-gray-700">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${accent ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

// Side-by-side position pill
function PosPill({ pos: p, other }: { pos: number | null; other: number | null }) {
  if (p === null) return <span className="text-gray-600 text-xs">—</span>
  let color = 'text-gray-300'
  if (other !== null) {
    if (p < other - 2)      color = 'text-green-400'   // ranks better
    else if (p > other + 2) color = 'text-red-400'     // ranks worse
    else                    color = 'text-yellow-400'  // similar
  }
  return <span className={`font-medium text-sm ${color}`}>{p.toFixed(1)}</span>
}

// Presence badge
function PresenceBadge({ presence, marketA, marketB }: { presence: string; marketA: string; marketB: string }) {
  if (presence === 'both') return <span className="text-[10px] bg-blue-900/50 text-blue-300 border border-blue-700 rounded px-1.5 py-0.5">Both</span>
  if (presence === 'a_only') return <span className="text-[10px] bg-orange-900/50 text-orange-300 border border-orange-700 rounded px-1.5 py-0.5">{marketLabel(marketA).split(' ')[0]} only</span>
  return <span className="text-[10px] bg-purple-900/50 text-purple-300 border border-purple-700 rounded px-1.5 py-0.5">{marketLabel(marketB).split(' ')[0]} only</span>
}

type SortKey = 'a_clicks' | 'b_clicks' | 'a_position' | 'b_position' | 'position_diff' | 'a_impressions' | 'b_impressions'

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function MultiMarketPage() {
  const [days,    setDays]    = useState(90)
  const [marketA, setMarketA] = useState('usa')
  const [marketB, setMarketB] = useState('idn')
  const [minImpr, setMinImpr] = useState(5)
  const [data,    setData]    = useState<ApiData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [tab,     setTab]     = useState<'queries' | 'gaps' | 'opportunities'>('queries')

  // Query tab controls
  const [presenceFilter, setPresenceFilter] = useState<'all' | 'both' | 'a_only' | 'b_only'>('all')
  const [search,         setSearch]         = useState('')
  const [sortKey,        setSortKey]        = useState<SortKey>('a_clicks')
  const [sortDir,        setSortDir]        = useState<'asc' | 'desc'>('desc')
  const [gapFilter,      setGapFilter]      = useState<'all' | 'a_only' | 'b_only'>('all')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/multi-market?days=${days}&market_a=${marketA}&market_b=${marketB}&min_impr=${minImpr}`
      )
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [days, marketA, marketB, minImpr])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Derived data ────────────────────────────────────────────────────────────
  const filteredQueries = (data?.queries ?? [])
    .filter(r => presenceFilter === 'all' || r.presence === presenceFilter)
    .filter(r => !search || r.query.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const va = a[sortKey] ?? (sortDir === 'desc' ? -Infinity : Infinity)
      const vb = b[sortKey] ?? (sortDir === 'desc' ? -Infinity : Infinity)
      return sortDir === 'desc' ? (vb as number) - (va as number) : (va as number) - (vb as number)
    })

  const filteredGaps = (data?.contentGaps ?? [])
    .filter(g => gapFilter === 'all' || g.gap_type === gapFilter)

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function ThCol({ label, sortable, k }: { label: string; sortable?: boolean; k?: SortKey }) {
    if (!sortable || !k) return <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400 whitespace-nowrap">{label}</th>
    const active = sortKey === k
    return (
      <th
        className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400 whitespace-nowrap cursor-pointer hover:text-white select-none"
        onClick={() => handleSort(k)}
      >
        {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : <span className="opacity-30">↕</span>}
      </th>
    )
  }

  // ── Market selector ─────────────────────────────────────────────────────────
  const marketOptions = Object.entries(MARKET_LABELS).map(([code, { label, flag }]) => ({
    code, label: `${flag} ${label}`,
  }))

  // ── Render ──────────────────────────────────────────────────────────────────
  const s = data?.summary

  return (
    <div className="p-6 space-y-6 text-white">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Multi-Market Dashboard</h1>
          <p className="text-gray-400 text-sm mt-0.5">Side-by-side keyword & traffic comparison across markets</p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Market A */}
          <select
            value={marketA}
            onChange={e => setMarketA(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
          >
            {marketOptions.filter(m => m.code !== marketB).map(m => (
              <option key={m.code} value={m.code}>{m.label}</option>
            ))}
          </select>

          <span className="text-gray-500 font-bold">vs</span>

          {/* Market B */}
          <select
            value={marketB}
            onChange={e => setMarketB(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
          >
            {marketOptions.filter(m => m.code !== marketA).map(m => (
              <option key={m.code} value={m.code}>{m.label}</option>
            ))}
          </select>

          {/* Days */}
          <div className="flex border border-gray-700 rounded-lg overflow-hidden">
            {DAYS_OPTIONS.map(d => (
              <button
                key={d.value}
                onClick={() => setDays(d.value)}
                className={`px-3 py-2 text-sm transition ${days === d.value ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                {d.label}
              </button>
            ))}
          </div>

          {/* Min impressions */}
          <select
            value={minImpr}
            onChange={e => setMinImpr(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
          >
            <option value={5}>≥5 impr</option>
            <option value={10}>≥10 impr</option>
            <option value={50}>≥50 impr</option>
            <option value={100}>≥100 impr</option>
          </select>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-900/30 border border-red-700 rounded-xl p-4 text-red-300 text-sm">{error}</div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-gray-800 rounded-xl p-4 h-20 animate-pulse" />
          ))}
        </div>
      )}

      {/* Content */}
      {!loading && s && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label={`${marketLabel(s.market_a)} Clicks`}
              value={fmt(s.total_clicks_a)}
              sub={`${fmt(s.total_impr_a)} impressions`}
              accent="text-blue-400"
            />
            <StatCard
              label={`${marketLabel(s.market_b)} Clicks`}
              value={fmt(s.total_clicks_b)}
              sub={`${fmt(s.total_impr_b)} impressions`}
              accent="text-purple-400"
            />
            <StatCard
              label={`${marketLabel(s.market_a)} Avg. Position`}
              value={s.avg_position_a.toFixed(1)}
              sub={`${marketLabel(s.market_b)}: ${s.avg_position_b.toFixed(1)}`}
            />
            <StatCard
              label="Shared Queries"
              value={String(s.queries_both)}
              sub={`of ${s.queries_total} total`}
            />
            <StatCard
              label={`${marketLabel(s.market_a)}-Only Queries`}
              value={String(s.queries_a_only)}
              sub="not ranking in other market"
              accent="text-orange-400"
            />
            <StatCard
              label={`${marketLabel(s.market_b)}-Only Queries`}
              value={String(s.queries_b_only)}
              sub="not ranking in other market"
              accent="text-pink-400"
            />
            <StatCard
              label="Content Gaps"
              value={String(s.content_gaps_a + s.content_gaps_b)}
              sub={`${s.content_gaps_a} ${marketLabel(s.market_a)} only · ${s.content_gaps_b} ${marketLabel(s.market_b)} only`}
              accent="text-yellow-400"
            />
            <StatCard
              label="Rank Opportunities"
              value={String(s.opportunities)}
              sub="10+ position gap between markets"
              accent="text-green-400"
            />
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-700 gap-1">
            {[
              { key: 'queries',       label: `🔍 Keyword Comparison (${(data?.queries ?? []).length})` },
              { key: 'gaps',         label: `📄 Content Gaps (${(data?.contentGaps ?? []).length})` },
              { key: 'opportunities', label: `🎯 Rank Opportunities (${(data?.opportunities ?? []).length})` },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key as typeof tab)}
                className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition ${
                  tab === t.key ? 'bg-gray-800 text-white border border-b-gray-800 border-gray-700' : 'text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Tab: Keyword Comparison ── */}
          {tab === 'queries' && (
            <div className="space-y-3">
              {/* Filters */}
              <div className="flex items-center gap-3 flex-wrap">
                <input
                  type="text"
                  placeholder="Search queries…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none w-56"
                />
                <div className="flex border border-gray-700 rounded-lg overflow-hidden text-sm">
                  {[
                    { key: 'all',    label: 'All' },
                    { key: 'both',   label: 'Both markets' },
                    { key: 'a_only', label: `${marketLabel(marketA).split(' ')[0]} only` },
                    { key: 'b_only', label: `${marketLabel(marketB).split(' ')[0]} only` },
                  ].map(f => (
                    <button
                      key={f.key}
                      onClick={() => setPresenceFilter(f.key as typeof presenceFilter)}
                      className={`px-3 py-1.5 transition ${presenceFilter === f.key ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-500">{filteredQueries.length} queries</p>
              </div>

              {/* Table */}
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-x-auto">
                <table className="w-full text-sm min-w-[700px]">
                  <thead className="border-b border-gray-700">
                    <tr>
                      <ThCol label="Query" />
                      <ThCol label="Presence" />
                      <ThCol label={`${marketLabel(marketA)} Clicks`}    sortable k="a_clicks"      />
                      <ThCol label={`${marketLabel(marketA)} Impr`}      sortable k="a_impressions" />
                      <ThCol label={`${marketLabel(marketA)} Pos`}       sortable k="a_position"    />
                      <ThCol label={`${marketLabel(marketB)} Clicks`}    sortable k="b_clicks"      />
                      <ThCol label={`${marketLabel(marketB)} Impr`}      sortable k="b_impressions" />
                      <ThCol label={`${marketLabel(marketB)} Pos`}       sortable k="b_position"    />
                      <ThCol label="Pos Gap"                             sortable k="position_diff" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredQueries.slice(0, 500).map((row, i) => (
                      <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30 transition">
                        <td className="py-2.5 px-3 max-w-[200px]">
                          <span className="text-white text-xs font-medium line-clamp-1">{row.query}</span>
                        </td>
                        <td className="py-2.5 px-3">
                          <PresenceBadge presence={row.presence} marketA={marketA} marketB={marketB} />
                        </td>
                        <td className="py-2.5 px-3 text-gray-300 text-xs text-right">{row.a_clicks > 0 ? fmt(row.a_clicks) : <span className="text-gray-600">—</span>}</td>
                        <td className="py-2.5 px-3 text-gray-400 text-xs text-right">{row.a_impressions > 0 ? fmt(row.a_impressions) : <span className="text-gray-600">—</span>}</td>
                        <td className="py-2.5 px-3 text-right">
                          <PosPill pos={row.a_position} other={row.b_position} />
                        </td>
                        <td className="py-2.5 px-3 text-gray-300 text-xs text-right">{row.b_clicks > 0 ? fmt(row.b_clicks) : <span className="text-gray-600">—</span>}</td>
                        <td className="py-2.5 px-3 text-gray-400 text-xs text-right">{row.b_impressions > 0 ? fmt(row.b_impressions) : <span className="text-gray-600">—</span>}</td>
                        <td className="py-2.5 px-3 text-right">
                          <PosPill pos={row.b_position} other={row.a_position} />
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {row.position_diff === null ? (
                            <span className="text-gray-600 text-xs">—</span>
                          ) : (
                            <span className={`text-xs font-medium ${Math.abs(row.position_diff) >= 10 ? (row.position_diff > 0 ? 'text-red-400' : 'text-green-400') : 'text-gray-400'}`}>
                              {row.position_diff > 0 ? '+' : ''}{row.position_diff.toFixed(1)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {filteredQueries.length === 0 && (
                      <tr>
                        <td colSpan={9} className="py-12 text-center text-gray-500">No queries match filters</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {filteredQueries.length > 500 && (
                <p className="text-xs text-gray-500 text-center">Showing top 500 of {filteredQueries.length} queries</p>
              )}
            </div>
          )}

          {/* ── Tab: Content Gaps ── */}
          {tab === 'gaps' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm text-gray-400">Pages with ≥20 impressions in one market but zero in the other.</p>
                <div className="flex border border-gray-700 rounded-lg overflow-hidden text-sm ml-auto">
                  {[
                    { key: 'all',    label: 'All gaps' },
                    { key: 'a_only', label: `${marketLabel(marketA).split(' ')[0]} only` },
                    { key: 'b_only', label: `${marketLabel(marketB).split(' ')[0]} only` },
                  ].map(f => (
                    <button
                      key={f.key}
                      onClick={() => setGapFilter(f.key as typeof gapFilter)}
                      className={`px-3 py-1.5 transition ${gapFilter === f.key ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-700">
                    <tr>
                      <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400">Page</th>
                      <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400">Only in</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Impressions</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Clicks</th>
                      <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGaps.map((gap, i) => (
                      <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30 transition">
                        <td className="py-2.5 px-3">
                          <a
                            href={gap.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:underline text-xs font-mono"
                          >
                            {gap.path}
                          </a>
                        </td>
                        <td className="py-2.5 px-3">
                          {gap.gap_type === 'a_only'
                            ? <span className="text-xs text-orange-300">{marketLabel(marketA)}</span>
                            : <span className="text-xs text-purple-300">{marketLabel(marketB)}</span>
                          }
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-300 text-xs">{fmt(gap.impressions)}</td>
                        <td className="py-2.5 px-3 text-right text-gray-300 text-xs">{fmt(gap.clicks)}</td>
                        <td className="py-2.5 px-3">
                          <span className="text-[10px] text-gray-400 italic">
                            {gap.gap_type === 'a_only'
                              ? `Consider localizing for ${marketLabel(marketB)}`
                              : `Consider localizing for ${marketLabel(marketA)}`}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {filteredGaps.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-gray-500">No content gaps found — both markets have similar page coverage.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Tab: Rank Opportunities ── */}
          {tab === 'opportunities' && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Queries ranking in both markets where one market is 10+ positions behind. Quick wins — if the content performs well in one market, it likely can rank higher in the other.
              </p>
              <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-700">
                    <tr>
                      <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400">Query</th>
                      <th className="py-2.5 px-3 text-left text-xs font-semibold text-gray-400">Weak Market</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Weak Pos</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Strong Pos</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Gap</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Impressions</th>
                      <th className="py-2.5 px-3 text-right text-xs font-semibold text-gray-400">Clicks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.opportunities ?? []).map((opp, i) => (
                      <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30 transition">
                        <td className="py-2.5 px-3 max-w-[200px]">
                          <span className="text-white text-xs font-medium">{opp.query}</span>
                        </td>
                        <td className="py-2.5 px-3">
                          {opp.weak_market === 'a'
                            ? <span className="text-orange-300 text-xs">{marketLabel(marketA)}</span>
                            : <span className="text-pink-300 text-xs">{marketLabel(marketB)}</span>}
                        </td>
                        <td className="py-2.5 px-3 text-right text-red-400 text-sm font-medium">
                          {opp.weak_position.toFixed(1)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-green-400 text-sm font-medium">
                          {opp.strong_position.toFixed(1)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${opp.position_gap >= 20 ? 'bg-red-900/50 text-red-300' : 'bg-yellow-900/50 text-yellow-300'}`}>
                            +{opp.position_gap.toFixed(0)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-400 text-xs">{fmt(opp.impressions)}</td>
                        <td className="py-2.5 px-3 text-right text-gray-300 text-xs">{fmt(opp.clicks)}</td>
                      </tr>
                    ))}
                    {(data?.opportunities ?? []).length === 0 && (
                      <tr>
                        <td colSpan={7} className="py-12 text-center text-gray-500">No major ranking gaps found between the two markets.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
