'use client'

import { useState, useEffect, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageEntry {
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
  cluster?: { keyword: string; url_slug: string | null; map_topic: string } | null
}

interface CannibalGroup {
  query: string
  pages: PageEntry[]
  total_clicks: number
  total_impressions: number
  split_score: number
  severity: 'critical' | 'warning' | 'info'
  recommendation: string
  map_topic: string | null
}

interface MapOverlap {
  keyword_a:   string
  slug_a:      string | null
  map_topic_a: string
  keyword_b:   string
  slug_b:      string | null
  map_topic_b: string
  similarity:  number
  type: 'exact' | 'near_exact' | 'similar'
}

interface Summary {
  totalQueriesScanned:  number
  cannibalisedQueries:  number
  criticalCount:        number
  warningCount:         number
  infoCount:            number
  estimatedLostClicks:  number
  mapOverlapCount:      number
  dateRange:            string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SEVERITY_STYLES = {
  critical: { bg: 'bg-red-900/30 border-red-800/50',   dot: 'bg-red-500',    text: 'text-red-400',    badge: 'bg-red-900/50 text-red-300 border-red-800'    },
  warning:  { bg: 'bg-yellow-900/20 border-yellow-800/40', dot: 'bg-yellow-500', text: 'text-yellow-400', badge: 'bg-yellow-900/50 text-yellow-300 border-yellow-800' },
  info:     { bg: 'bg-gray-900 border-gray-800',        dot: 'bg-gray-600',   text: 'text-gray-400',   badge: 'bg-gray-800 text-gray-400 border-gray-700'    },
}

const OVERLAP_TYPE_STYLES = {
  exact:      'bg-red-900/50 text-red-300 border-red-800',
  near_exact: 'bg-orange-900/50 text-orange-300 border-orange-800',
  similar:    'bg-yellow-900/40 text-yellow-300 border-yellow-800',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

function fmtPct(n: number) { return `${(n * 100).toFixed(1)}%` }
function fmtNum(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

// ── SplitBar ──────────────────────────────────────────────────────────────────
// Shows proportional clicks distribution across competing pages
function SplitBar({ pages }: { pages: PageEntry[] }) {
  const total = pages.reduce((s, p) => s + p.clicks, 0)
  if (total === 0) return <span className="text-gray-700 text-xs">no clicks</span>
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6']
  const sorted = [...pages].sort((a, b) => b.clicks - a.clicks)

  return (
    <div className="flex h-2 rounded-full overflow-hidden w-full gap-px">
      {sorted.map((p, i) => (
        <div
          key={p.page}
          title={`${extractPath(p.page)}: ${p.clicks} clicks (${Math.round(p.clicks / total * 100)}%)`}
          style={{ width: `${(p.clicks / total) * 100}%`, backgroundColor: colors[i % colors.length] }}
        />
      ))}
    </div>
  )
}

// ── CannibalCard ──────────────────────────────────────────────────────────────
function CannibalCard({ group }: { group: CannibalGroup }) {
  const [expanded, setExpanded] = useState(false)
  const style = SEVERITY_STYLES[group.severity]
  const maxClicks = Math.max(...group.pages.map(p => p.clicks), 1)

  return (
    <div className={`border rounded-xl overflow-hidden transition ${style.bg}`}>
      {/* Header row */}
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition"
        onClick={() => setExpanded(e => !e)}
      >
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-white text-xs font-semibold">{group.query}</span>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${style.badge}`}>
              {group.severity}
            </span>
            {group.map_topic && (
              <span className="text-gray-600 text-[10px]">· {group.map_topic}</span>
            )}
          </div>

          {/* Split bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 max-w-[200px]">
              <SplitBar pages={group.pages} />
            </div>
            <span className="text-gray-500 text-[10px]">
              {group.pages.length} pages competing · {fmtNum(group.total_clicks)} clicks · split {Math.round(group.split_score * 100)}%
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-right hidden md:block">
            <p className="text-white text-xs font-semibold">{fmtNum(group.total_impressions)}</p>
            <p className="text-gray-600 text-[10px]">impressions</p>
          </div>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-700/50 px-4 py-4">
          {/* Competing pages table */}
          <div className="mb-4">
            <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">Competing Pages</p>
            <div className="space-y-2">
              {group.pages.map((p, i) => {
                const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6']
                const barPct = maxClicks > 0 ? (p.clicks / maxClicks) * 100 : 0
                return (
                  <div key={p.page} className="bg-gray-900/60 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full flex-shrink-0 mt-1" style={{ backgroundColor: colors[i % colors.length] }} />
                      <div className="flex-1 min-w-0">
                        <a
                          href={p.page}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 text-xs truncate block max-w-[400px] transition"
                          onClick={e => e.stopPropagation()}
                        >{extractPath(p.page)}</a>
                        {p.cluster && (
                          <p className="text-gray-600 text-[10px] mt-0.5">
                            Keyword Map: "{p.cluster.keyword}" · {p.cluster.map_topic}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs flex-shrink-0">
                        <div className="text-right">
                          <p className={`font-semibold ${i === 0 ? 'text-white' : 'text-gray-400'}`}>{p.clicks}</p>
                          <p className="text-gray-600 text-[10px]">clicks</p>
                        </div>
                        <div className="text-right">
                          <p className="text-gray-400 font-semibold">{fmtNum(p.impressions)}</p>
                          <p className="text-gray-600 text-[10px]">impr</p>
                        </div>
                        <div className="text-right">
                          <p className={`font-semibold ${p.position <= 5 ? 'text-green-400' : p.position <= 15 ? 'text-yellow-400' : 'text-gray-400'}`}>
                            #{p.position.toFixed(1)}
                          </p>
                          <p className="text-gray-600 text-[10px]">position</p>
                        </div>
                        <div className="text-right hidden lg:block">
                          <p className="text-gray-400">{fmtPct(p.ctr)}</p>
                          <p className="text-gray-600 text-[10px]">CTR</p>
                        </div>
                      </div>
                    </div>
                    {/* Click share bar */}
                    <div className="mt-2 ml-4">
                      <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${barPct}%`, backgroundColor: colors[i % colors.length] }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Recommendation */}
          <div className="bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2.5">
            <p className="text-blue-400 text-[10px] font-semibold uppercase tracking-wider mb-1">Recommended fix</p>
            <p className="text-gray-300 text-xs leading-relaxed">{group.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── OverlapRow ────────────────────────────────────────────────────────────────
function OverlapRow({ overlap: o }: { overlap: MapOverlap }) {
  const style = OVERLAP_TYPE_STYLES[o.type]
  const simPct = Math.round(o.similarity * 100)

  return (
    <div className="px-4 py-3 border-t border-gray-800/60 hover:bg-gray-800/20 transition flex items-start gap-3">
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 mt-0.5 ${style}`}>
        {o.type.replace('_', ' ')}
      </span>

      <div className="flex-1 min-w-0 grid grid-cols-2 gap-4">
        <div className="min-w-0">
          <p className="text-gray-200 text-xs font-medium truncate">{o.keyword_a}</p>
          <p className="text-gray-600 text-[10px]">{o.map_topic_a}</p>
          {o.slug_a && <p className="text-gray-700 text-[10px] font-mono">/{o.slug_a}</p>}
        </div>
        <div className="min-w-0">
          <p className="text-gray-200 text-xs font-medium truncate">{o.keyword_b}</p>
          <p className="text-gray-600 text-[10px]">{o.map_topic_b}</p>
          {o.slug_b && <p className="text-gray-700 text-[10px] font-mono">/{o.slug_b}</p>}
        </div>
      </div>

      <div className="text-right flex-shrink-0">
        <p className={`text-xs font-bold ${simPct >= 85 ? 'text-red-400' : simPct >= 70 ? 'text-orange-400' : 'text-yellow-400'}`}>
          {simPct}%
        </p>
        <p className="text-gray-600 text-[10px]">similar</p>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'gsc' | 'map'

export default function CannibalizationPage() {
  const [data, setData]       = useState<{ summary: Summary; groups: CannibalGroup[]; overlaps: MapOverlap[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [tab,     setTab]     = useState<Tab>('gsc')
  const [days,    setDays]    = useState(90)
  const [minImpr, setMinImpr] = useState(10)

  // Filters
  const [severityFilter, setSeverityFilter] = useState<string>('all')
  const [searchGSC,      setSearchGSC]      = useState('')
  const [searchMap,      setSearchMap]      = useState('')
  const [overlapFilter,  setOverlapFilter]  = useState<string>('all')

  useEffect(() => { load() }, [days, minImpr]) // eslint-disable-line

  async function load() {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ days: String(days), min_impr: String(minImpr) })
      const res  = await fetch(`/api/cannibalization?${params}`)
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const filteredGroups = useMemo(() => {
    if (!data) return []
    let list = data.groups
    if (severityFilter !== 'all') list = list.filter(g => g.severity === severityFilter)
    if (searchGSC.trim()) {
      const q = searchGSC.toLowerCase()
      list = list.filter(g =>
        g.query.toLowerCase().includes(q) ||
        g.pages.some(p => extractPath(p.page).toLowerCase().includes(q)) ||
        (g.map_topic ?? '').toLowerCase().includes(q)
      )
    }
    return list
  }, [data, severityFilter, searchGSC])

  const filteredOverlaps = useMemo(() => {
    if (!data) return []
    let list = data.overlaps
    if (overlapFilter !== 'all') list = list.filter(o => o.type === overlapFilter)
    if (searchMap.trim()) {
      const q = searchMap.toLowerCase()
      list = list.filter(o =>
        o.keyword_a.toLowerCase().includes(q) ||
        o.keyword_b.toLowerCase().includes(q) ||
        o.map_topic_a.toLowerCase().includes(q) ||
        o.map_topic_b.toLowerCase().includes(q)
      )
    }
    return list
  }, [data, overlapFilter, searchMap])

  if (loading) return (
    <div className="flex items-center justify-center h-full py-32">
      <LottieLoader size={80} text="Scanning for cannibalization…" />
    </div>
  )

  if (error) return (
    <div className="p-8">
      <div className="bg-red-900/30 border border-red-700 rounded-xl px-5 py-4 text-red-300 text-sm">{error}</div>
    </div>
  )

  const { summary } = data!

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-white font-bold text-xl">Cannibalization Detector</h1>
          <p className="text-gray-500 text-sm mt-1">
            Pages competing for the same keyword — both from GSC data and Keyword Map overlap
          </p>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Lookback */}
          <div className="flex bg-gray-800 rounded-lg p-0.5 gap-0.5">
            {[30, 90, 180].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs rounded-md transition font-medium ${days === d ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >{d}d</button>
            ))}
          </div>
          {/* Min impressions */}
          <select
            value={minImpr}
            onChange={e => setMinImpr(parseInt(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 focus:outline-none"
          >
            {[5, 10, 50, 100].map(v => (
              <option key={v} value={v}>≥{v} impr</option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition disabled:opacity-50"
          >↺ Refresh</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 col-span-2">
          <p className="text-gray-500 text-xs mb-1">Queries scanned</p>
          <p className="text-white font-bold text-xl">{summary.totalQueriesScanned.toLocaleString()}</p>
          <p className="text-gray-600 text-[10px]">{summary.dateRange}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.criticalCount > 0 ? 'bg-red-900/20 border-red-800/40' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">🔴 Critical</p>
          <p className={`font-bold text-xl ${summary.criticalCount > 0 ? 'text-red-400' : 'text-gray-400'}`}>{summary.criticalCount}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.warningCount > 0 ? 'bg-yellow-900/20 border-yellow-800/30' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">🟡 Warning</p>
          <p className={`font-bold text-xl ${summary.warningCount > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>{summary.warningCount}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">ℹ️ Info</p>
          <p className="text-gray-400 font-bold text-xl">{summary.infoCount}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.estimatedLostClicks > 0 ? 'bg-orange-900/20 border-orange-800/30' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">Est. lost clicks</p>
          <p className={`font-bold text-xl ${summary.estimatedLostClicks > 0 ? 'text-orange-400' : 'text-gray-400'}`}>
            ~{fmtNum(summary.estimatedLostClicks)}
          </p>
          <p className="text-gray-600 text-[10px]">from split traffic</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">Map overlaps</p>
          <p className={`font-bold text-xl ${summary.mapOverlapCount > 0 ? 'text-yellow-400' : 'text-green-400'}`}>{summary.mapOverlapCount}</p>
          <p className="text-gray-600 text-[10px]">planned risks</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-5 w-fit">
        <button
          onClick={() => setTab('gsc')}
          className={`px-4 py-2 text-xs font-medium rounded-lg transition ${tab === 'gsc' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
        >
          📊 GSC Cannibalization ({summary.cannibalisedQueries})
        </button>
        <button
          onClick={() => setTab('map')}
          className={`px-4 py-2 text-xs font-medium rounded-lg transition ${tab === 'map' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
        >
          🗺️ Keyword Map Overlaps ({summary.mapOverlapCount})
        </button>
      </div>

      {/* ── GSC Tab ──────────────────────────────────────────────────────────── */}
      {tab === 'gsc' && (
        <div>
          {/* Context note */}
          <div className="mb-4 flex items-start gap-2 text-xs bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-blue-500 flex-shrink-0">ℹ</span>
            <span className="text-gray-600">
              A query is flagged when 2+ different pages appear in GSC for the same search term.
              The <span className="text-white">split score</span> shows how evenly clicks are divided — higher = Google is more confused.
              <span className="text-orange-400 ml-1">Est. lost clicks</span> = clicks that would consolidate to one page if cannibalization were fixed.
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <input
              type="text"
              value={searchGSC}
              onChange={e => setSearchGSC(e.target.value)}
              placeholder="Search query or page URL…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-64"
            />
            <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
              {['all', 'critical', 'warning', 'info'].map(s => (
                <button
                  key={s}
                  onClick={() => setSeverityFilter(s)}
                  className={`px-3 py-1 text-xs rounded-md transition capitalize ${severityFilter === s ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                >{s === 'all' ? 'All' : s}</button>
              ))}
            </div>
            <span className="text-gray-600 text-xs ml-auto">{filteredGroups.length} queries</span>
          </div>

          {filteredGroups.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-16 text-center">
              <p className="text-3xl mb-3">✅</p>
              <p className="text-gray-400 text-sm font-medium">No cannibalization detected</p>
              <p className="text-gray-600 text-xs mt-1">
                {severityFilter !== 'all' ? 'Try removing the severity filter' : `No queries with ${minImpr}+ impressions had competing pages`}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filteredGroups.map(g => (
                <CannibalCard key={g.query} group={g} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Map Overlaps Tab ─────────────────────────────────────────────────── */}
      {tab === 'map' && (
        <div>
          <div className="mb-4 flex items-start gap-2 text-xs bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-blue-500 flex-shrink-0">ℹ</span>
            <span className="text-gray-600">
              Keyword pairs across your Keyword Map clusters with high semantic similarity.
              These are <span className="text-yellow-400">planned risks</span> — they may cause cannibalization when published.
              <span className="text-red-400 ml-1">Exact</span> = identical keyword.
              <span className="text-orange-400 ml-1">Near-exact</span> = ≥85% token overlap.
              <span className="text-yellow-400 ml-1">Similar</span> = ≥60% overlap.
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <input
              type="text"
              value={searchMap}
              onChange={e => setSearchMap(e.target.value)}
              placeholder="Search keyword or topic…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-64"
            />
            <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
              {[
                { v: 'all',        l: 'All' },
                { v: 'exact',      l: '🔴 Exact' },
                { v: 'near_exact', l: '🟠 Near-exact' },
                { v: 'similar',    l: '🟡 Similar' },
              ].map(f => (
                <button
                  key={f.v}
                  onClick={() => setOverlapFilter(f.v)}
                  className={`px-3 py-1 text-xs rounded-md transition ${overlapFilter === f.v ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                >{f.l}</button>
              ))}
            </div>
            <span className="text-gray-600 text-xs ml-auto">{filteredOverlaps.length} pairs</span>
          </div>

          {filteredOverlaps.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-16 text-center">
              <p className="text-3xl mb-3">✅</p>
              <p className="text-gray-400 text-sm font-medium">No keyword map overlaps found</p>
              <p className="text-gray-600 text-xs mt-1">All cluster keywords are sufficiently distinct</p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-800/40 border-b border-gray-800 grid grid-cols-[100px_1fr_60px] gap-3">
                <span className="text-gray-500 text-xs font-medium">Type</span>
                <span className="text-gray-500 text-xs font-medium">Keyword A vs Keyword B</span>
                <span className="text-gray-500 text-xs font-medium text-right">Similarity</span>
              </div>
              {filteredOverlaps.map((o, i) => (
                <OverlapRow key={i} overlap={o} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
