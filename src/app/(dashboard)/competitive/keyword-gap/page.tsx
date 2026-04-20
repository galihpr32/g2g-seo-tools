'use client'

import { useState, useEffect, useMemo } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'

interface Competitor { id: string; domain: string; name: string; active: boolean }

interface GapRow {
  keyword: string
  searchVolume: number
  cpc: number
  g2g_position: number | null
  competitor_position: number | null
  position_diff: number | null
  g2g_url: string | null
  competitor_url: string | null
}

interface GapResult {
  competitor_domain: string
  g2g_domain: string
  database: string
  summary: { g2g_total: number; competitor_total: number; gaps: number; behind: number; winning: number }
  gaps: GapRow[]
  behind: GapRow[]
  winning: GapRow[]
}

type Tab = 'gaps' | 'behind' | 'winning'
type SortKey = 'keyword' | 'searchVolume' | 'g2g_position' | 'competitor_position' | 'position_diff'

function positionBadge(pos: number | null) {
  if (pos === null) return <span className="text-gray-600 text-xs">—</span>
  const color = pos <= 3 ? 'text-green-400' : pos <= 10 ? 'text-yellow-400' : pos <= 20 ? 'text-orange-400' : 'text-gray-400'
  return <span className={`text-xs font-semibold ${color}`}>#{pos}</span>
}

function GapTable({ rows, tab, competitorDomain }: { rows: GapRow[]; tab: Tab; competitorDomain: string }) {
  const [search, setSearch]     = useState('')
  const [sortKey, setSortKey]   = useState<SortKey>('searchVolume')
  const [sortDir, setSortDir]   = useState<'asc' | 'desc'>('desc')
  const [minVol,  setMinVol]    = useState('')
  const [page,    setPage]      = useState(1)
  const PAGE_SIZE = 50

  const filtered = useMemo(() => {
    let list = rows
    if (search.trim()) list = list.filter(r => r.keyword.includes(search.trim().toLowerCase()))
    if (minVol && parseInt(minVol) > 0) list = list.filter(r => r.searchVolume >= parseInt(minVol))
    return [...list].sort((a, b) => {
      let va: number | string, vb: number | string
      switch (sortKey) {
        case 'keyword':             va = a.keyword;             vb = b.keyword;             break
        case 'searchVolume':        va = a.searchVolume;        vb = b.searchVolume;        break
        case 'g2g_position':        va = a.g2g_position ?? 999; vb = b.g2g_position ?? 999; break
        case 'competitor_position': va = a.competitor_position ?? 999; vb = b.competitor_position ?? 999; break
        case 'position_diff':       va = a.position_diff ?? 999; vb = b.position_diff ?? 999; break
        default:                    va = 0; vb = 0
      }
      if (typeof va === 'string') return sortDir === 'asc' ? va.localeCompare(vb as string) : (vb as string).localeCompare(va)
      return sortDir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number)
    })
  }, [rows, search, minVol, sortKey, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  function th(key: SortKey, label: string, align: 'left' | 'right' = 'right') {
    const active = sortKey === key
    return (
      <th
        onClick={() => { if (active) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDir(key === 'keyword' ? 'asc' : 'desc') }; setPage(1) }}
        className={`py-3 px-4 text-xs font-medium cursor-pointer select-none hover:text-white transition ${align === 'left' ? 'text-left' : 'text-right'} ${active ? 'text-white' : 'text-gray-500'}`}
      >
        {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : <span className="text-gray-700">↕</span>}
      </th>
    )
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <input
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
          placeholder="Search keyword…"
          className="flex-1 max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
        />
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Min volume:</label>
          <input
            value={minVol} onChange={e => { setMinVol(e.target.value); setPage(1) }}
            placeholder="e.g. 500"
            className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
          />
        </div>
        <span className="text-xs text-gray-500 ml-auto">{filtered.length} keywords</span>
      </div>

      {filtered.length === 0 ? (
        <p className="text-gray-500 text-sm text-center py-8">No keywords match your filters.</p>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-800">
              <tr>
                {th('keyword', 'Keyword', 'left')}
                {th('searchVolume', 'Volume')}
                <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">CPC</th>
                {th('g2g_position', 'G2G pos')}
                {th('competitor_position', `${competitorDomain} pos`)}
                {tab !== 'winning' && th('position_diff', 'Gap')}
                <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">G2G URL</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map((r, i) => (
                <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/40 transition">
                  <td className="py-2.5 px-4">
                    <span className="text-white text-xs font-medium">{r.keyword}</span>
                  </td>
                  <td className="py-2.5 px-4 text-right text-gray-300 text-xs">
                    {r.searchVolume > 0 ? r.searchVolume.toLocaleString() : '—'}
                  </td>
                  <td className="py-2.5 px-4 text-right text-gray-500 text-xs">
                    {r.cpc > 0 ? `$${r.cpc.toFixed(2)}` : '—'}
                  </td>
                  <td className="py-2.5 px-4 text-right">{positionBadge(r.g2g_position)}</td>
                  <td className="py-2.5 px-4 text-right">{positionBadge(r.competitor_position)}</td>
                  {tab !== 'winning' && (
                    <td className="py-2.5 px-4 text-right">
                      {r.position_diff !== null
                        ? <span className="text-red-400 text-xs font-semibold">+{r.position_diff}</span>
                        : <span className="text-orange-400 text-xs">not ranking</span>}
                    </td>
                  )}
                  <td className="py-2.5 px-4 text-right">
                    {r.g2g_url ? (
                      <a href={r.g2g_url} target="_blank" rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs truncate max-w-[160px] inline-block" title={r.g2g_url}>
                        {new URL(r.g2g_url).pathname}
                      </a>
                    ) : <span className="text-gray-700 text-xs">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">‹ Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                  className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">Next ›</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function KeywordGapPage() {
  const [competitors, setCompetitors]         = useState<Competitor[]>([])
  const [selectedCompetitor, setCompetitor]   = useState('')
  const [database, setDatabase]               = useState('us')
  const [limit, setLimit]                     = useState('500')
  const [loading, setLoading]                 = useState(false)
  const [loadingCompetitors, setLoadingComp]  = useState(true)
  const [result, setResult]                   = useState<GapResult | null>(null)
  const [error, setError]                     = useState<string | null>(null)
  const [activeTab, setActiveTab]             = useState<Tab>('gaps')

  useEffect(() => {
    async function fetchCompetitors() {
      try {
        const res = await fetch('/api/competitors')
        if (res.ok) {
          const { competitors } = await res.json()
          const active = competitors.filter((c: Competitor) => c.active)
          setCompetitors(active)
          if (active.length > 0) setCompetitor(active[0].domain)
        }
      } catch { /* silent */ }
      finally { setLoadingComp(false) }
    }
    fetchCompetitors()
  }, [])

  async function runAnalysis() {
    if (!selectedCompetitor) return
    setLoading(true); setError(null); setResult(null)
    try {
      const res = await fetch('/api/competitive/keyword-gap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitor_domain: selectedCompetitor, database, limit: parseInt(limit) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
      setActiveTab('gaps')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const TAB_LABELS: { key: Tab; label: string; color: string; desc: string }[] = [
    { key: 'gaps',    label: 'Keyword Gaps',  color: 'text-red-400',    desc: 'Competitor ranks top 30, G2G not ranking' },
    { key: 'behind',  label: 'Falling Behind', color: 'text-orange-400', desc: 'Both rank, but G2G is 10+ positions behind' },
    { key: 'winning', label: 'Winning',        color: 'text-green-400',  desc: 'G2G ranks better or competitor not ranking' },
  ]

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔍 Keyword Gap Finder</h1>
        <p className="text-gray-400 text-sm mt-1">
          Compare G2G's organic keyword rankings against a competitor to find opportunities.
        </p>
      </div>

      {/* Config bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-400 mb-1.5">Competitor domain</label>
            {loadingCompetitors ? (
              <div className="h-10 bg-gray-800 rounded-lg animate-pulse" />
            ) : competitors.length === 0 ? (
              <div className="flex items-center gap-3">
                <p className="text-gray-500 text-sm">No competitors yet.</p>
                <a href="/competitive/competitors" className="text-xs text-red-400 hover:text-red-300 underline transition">+ Add competitors →</a>
              </div>
            ) : (
              <select value={selectedCompetitor} onChange={e => setCompetitor(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
                {competitors.map(c => (
                  <option key={c.id} value={c.domain}>{c.name} ({c.domain})</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Market</label>
            <select value={database} onChange={e => setDatabase(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              {SERP_COUNTRIES.map(c => (
                <option key={c.code} value={c.semrushDb}>{c.flag} {c.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Keywords to fetch</label>
            <select value={limit} onChange={e => setLimit(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="200">Top 200</option>
              <option value="500">Top 500</option>
              <option value="1000">Top 1,000</option>
            </select>
          </div>

          <button
            onClick={runAnalysis}
            disabled={loading || !selectedCompetitor}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition flex items-center gap-2"
          >
            {loading ? '⏳ Analyzing…' : '🔍 Run analysis'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Uses SEMrush <code className="text-gray-500">domain_organic</code> API — fetches top organic keywords for G2G and the competitor, then computes the gap.
          Each run costs ~2 SEMrush API units.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">
          ⚠️ {error}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <LottieLoader size={90} text="Fetching keywords from SEMrush…" />
        </div>
      )}

      {result && !loading && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-5 gap-3 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{result.summary.g2g_total.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">G2G keywords</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{result.summary.competitor_total.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">{result.competitor_domain} keywords</p>
            </div>
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-red-400">{result.summary.gaps}</p>
              <p className="text-xs text-gray-500 mt-1">Keyword gaps</p>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-400">{result.summary.behind}</p>
              <p className="text-xs text-gray-500 mt-1">Falling behind</p>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-400">{result.summary.winning}</p>
              <p className="text-xs text-gray-500 mt-1">G2G winning</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-1 mb-5 border-b border-gray-800">
            {TAB_LABELS.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
                  activeTab === t.key
                    ? `${t.color} border-current`
                    : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
              >
                {t.label}
                <span className="ml-2 text-xs opacity-70">
                  {t.key === 'gaps' ? result.gaps.length : t.key === 'behind' ? result.behind.length : result.winning.length}
                </span>
              </button>
            ))}
            <span className="ml-auto text-xs text-gray-600 pb-2">
              {TAB_LABELS.find(t => t.key === activeTab)?.desc}
            </span>
          </div>

          {/* Table */}
          <GapTable
            rows={activeTab === 'gaps' ? result.gaps : activeTab === 'behind' ? result.behind : result.winning}
            tab={activeTab}
            competitorDomain={result.competitor_domain}
          />
        </>
      )}
    </div>
  )
}
