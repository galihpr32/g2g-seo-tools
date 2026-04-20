'use client'

import { useState, useMemo } from 'react'
import { SERP_COUNTRIES } from '@/lib/country-config'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────
interface FeatureSummary {
  code:        number
  label:       string
  captured:    number
  available:   number
  volume:      number
  captureRate: number
}

interface SerpFeatureRow {
  keyword:      string
  position:     number
  searchVolume: number
  url:          string
  captured:     number[]
  available:    number[]
}

interface SerpFeaturesData {
  domain:               string
  database:             string
  totalKeywords:        number
  keywordsWithFeatures: number
  summary:              FeatureSummary[]
  rows:                 SerpFeatureRow[]
}

// ── Feature label & icon maps ─────────────────────────────────────────────────
const FEATURE_ICON: Record<number, string> = {
  1:  '💡', 2:  '🧠', 3:  '🎠', 4:  '📍', 5:  '🖼️',
  7:  '⭐', 8:  '🛒', 10: '⭐', 11: '🔗', 12: '▶️',
  13: '🐦', 14: '📰', 15: '❓', 16: '📱', 17: '⚡', 22: '🎬',
}

const FEATURE_COLOR: Record<number, string> = {
  7:  'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',  // Featured Snippet
  15: 'bg-blue-500/15 text-blue-300 border-blue-500/30',        // PAA
  5:  'bg-purple-500/15 text-purple-300 border-purple-500/30',  // Image Pack
  8:  'bg-green-500/15 text-green-300 border-green-500/30',     // Shopping
  12: 'bg-red-500/15 text-red-300 border-red-500/30',           // Video
  14: 'bg-orange-500/15 text-orange-300 border-orange-500/30',  // News
  11: 'bg-teal-500/15 text-teal-300 border-teal-500/30',        // Sitelinks
  2:  'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',  // Knowledge Panel
}
const FEATURE_COLOR_DEFAULT = 'bg-gray-500/15 text-gray-300 border-gray-500/30'

function FeaturePill({ code, label }: { code: number; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border flex-shrink-0 ${FEATURE_COLOR[code] ?? FEATURE_COLOR_DEFAULT}`}>
      <span>{FEATURE_ICON[code] ?? '•'}</span>
      {label}
    </span>
  )
}

// ── Capture Rate Bar ──────────────────────────────────────────────────────────
function CaptureBar({ rate }: { rate: number }) {
  const color = rate >= 60 ? 'bg-green-500' : rate >= 30 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${rate}%` }} />
      </div>
      <span className="text-xs text-gray-400 w-8 text-right">{rate}%</span>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function SerpFeaturesPage() {
  const [database, setDatabase]   = useState('us')
  const [limit,    setLimit]      = useState('1000')
  const [loading,  setLoading]    = useState(false)
  const [data,     setData]       = useState<SerpFeaturesData | null>(null)
  const [error,    setError]      = useState<string | null>(null)

  // Filters
  const [search,          setSearch]        = useState('')
  const [filterFeature,   setFilterFeature] = useState<number | null>(null)
  const [showCaptured,    setShowCaptured]  = useState<'all' | 'captured' | 'missed'>('all')
  const [minVol,          setMinVol]        = useState('')
  const [page,            setPage]          = useState(1)
  const PAGE_SIZE = 50

  async function runFetch() {
    setLoading(true); setError(null); setData(null); setPage(1)
    setSearch(''); setFilterFeature(null); setShowCaptured('all'); setMinVol('')
    try {
      const params = new URLSearchParams({ database, limit })
      const res = await fetch(`/api/serp-features?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    if (!data) return []
    let list = data.rows

    if (search.trim())
      list = list.filter(r => r.keyword.includes(search.trim().toLowerCase()))

    if (minVol && parseInt(minVol) > 0)
      list = list.filter(r => r.searchVolume >= parseInt(minVol))

    if (filterFeature !== null) {
      list = list.filter(r =>
        r.captured.includes(filterFeature) || r.available.includes(filterFeature)
      )
    }

    if (showCaptured === 'captured')
      list = list.filter(r => r.captured.length > 0)
    else if (showCaptured === 'missed')
      list = list.filter(r => r.captured.length === 0 && r.available.length > 0)

    return list.sort((a, b) => b.searchVolume - a.searchVolume)
  }, [data, search, minVol, filterFeature, showCaptured])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const paginated  = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const topFeatures = data?.summary.filter(f => f.captured > 0).slice(0, 6) ?? []

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">⭐ SERP Features</h1>
        <p className="text-gray-400 text-sm mt-1">
          Analyse which SERP features G2G captures vs. what's available on your ranking keywords.
        </p>
      </div>

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-end gap-4 flex-wrap">
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
            <label className="block text-xs text-gray-400 mb-1.5">Keywords to scan</label>
            <select value={limit} onChange={e => setLimit(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="500">Top 500</option>
              <option value="1000">Top 1,000</option>
              <option value="2000">Top 2,000</option>
            </select>
          </div>
          <button onClick={runFetch} disabled={loading}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            {loading ? '⏳ Loading…' : '⭐ Analyse SERP Features'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Uses SEMrush <code className="text-gray-500">domain_organic</code> with SERP feature columns (Fp / Fk). ~1 SEMrush unit per run.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-red-400 text-sm">⚠️ {error}</div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <LottieLoader size={90} text="Fetching SERP features from SEMrush…" />
        </div>
      )}

      {data && !loading && (
        <>
          {/* Overview cards */}
          <div className="grid grid-cols-4 gap-3 mb-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{data.totalKeywords.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">Keywords scanned</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-white">{data.keywordsWithFeatures.toLocaleString()}</p>
              <p className="text-xs text-gray-500 mt-1">Keywords with SERP features</p>
            </div>
            <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-400">
                {data.summary.reduce((s, f) => s + f.captured, 0).toLocaleString()}
              </p>
              <p className="text-xs text-gray-500 mt-1">Feature appearances captured</p>
            </div>
            <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-400">
                {data.summary.reduce((s, f) => s + f.available - f.captured, 0).toLocaleString()}
              </p>
              <p className="text-xs text-gray-500 mt-1">Missed opportunities</p>
            </div>
          </div>

          {/* Feature breakdown cards */}
          {data.summary.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
              <h2 className="text-white font-semibold text-sm mb-4">Feature breakdown</h2>
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {data.summary.map(f => (
                  <div key={f.code}
                    onClick={() => setFilterFeature(prev => prev === f.code ? null : f.code)}
                    className={`cursor-pointer rounded-lg p-3 border transition ${
                      filterFeature === f.code
                        ? 'bg-red-500/10 border-red-500/30'
                        : 'bg-gray-800/40 border-gray-800 hover:border-gray-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-white flex items-center gap-1.5">
                        <span>{FEATURE_ICON[f.code] ?? '•'}</span>
                        {f.label}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-green-400 font-semibold">{f.captured.toLocaleString()}</span>
                        <span className="text-gray-600 text-xs">/</span>
                        <span className="text-xs text-gray-400">{f.available.toLocaleString()}</span>
                      </div>
                    </div>
                    <CaptureBar rate={f.captureRate} />
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-600 mt-3">
                Green / yellow / red bar = capture rate. Click a card to filter keywords.
              </p>
            </div>
          )}

          {/* Keyword table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            {/* Filters */}
            <div className="p-4 border-b border-gray-800 flex items-center gap-3 flex-wrap">
              <input
                value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
                placeholder="Search keyword…"
                className="flex-1 min-w-[180px] max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
              />
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500">Min vol:</label>
                <input value={minVol} onChange={e => { setMinVol(e.target.value); setPage(1) }}
                  placeholder="500"
                  className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
              </div>
              {/* Captured / missed toggle */}
              <div className="flex rounded-lg overflow-hidden border border-gray-700">
                {(['all', 'captured', 'missed'] as const).map(v => (
                  <button key={v} onClick={() => { setShowCaptured(v); setPage(1) }}
                    className={`text-xs px-3 py-1.5 transition capitalize ${
                      showCaptured === v ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
                    }`}>
                    {v === 'all' ? 'All' : v === 'captured' ? '✅ Captured' : '⚠️ Missed'}
                  </button>
                ))}
              </div>
              {filterFeature !== null && (
                <button onClick={() => setFilterFeature(null)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 flex items-center gap-1">
                  {FEATURE_ICON[filterFeature]} {data.summary.find(f => f.code === filterFeature)?.label}
                  <span className="ml-1">✕</span>
                </button>
              )}
              <span className="text-xs text-gray-500 ml-auto">{filtered.length} keywords</span>
            </div>

            <table className="w-full text-sm">
              <thead className="border-b border-gray-800">
                <tr>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Keyword</th>
                  <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">Pos</th>
                  <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">Volume</th>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Captured features</th>
                  <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Available (missed)</th>
                  <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">URL</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((r, i) => {
                  const missed = r.available.filter(c => !r.captured.includes(c))
                  return (
                    <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/30 transition">
                      <td className="py-2.5 px-4">
                        <span className="text-white text-xs font-medium">{r.keyword}</span>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {r.position <= 3
                          ? <span className="text-green-400 text-xs font-semibold">#{r.position}</span>
                          : r.position <= 10
                          ? <span className="text-yellow-400 text-xs font-semibold">#{r.position}</span>
                          : <span className="text-gray-400 text-xs">#{r.position}</span>}
                      </td>
                      <td className="py-2.5 px-4 text-right text-gray-300 text-xs">
                        {r.searchVolume > 0 ? r.searchVolume.toLocaleString() : '—'}
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex flex-wrap gap-1">
                          {r.captured.length === 0
                            ? <span className="text-gray-700 text-xs">—</span>
                            : r.captured.map(code => {
                                const f = data.summary.find(f => f.code === code)
                                return f ? <FeaturePill key={code} code={code} label={f.label} /> : null
                              })
                          }
                        </div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex flex-wrap gap-1">
                          {missed.length === 0
                            ? <span className="text-gray-700 text-xs">—</span>
                            : missed.map(code => {
                                const f = data.summary.find(f => f.code === code)
                                return f ? (
                                  <span key={code} className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border bg-gray-800/60 text-gray-500 border-gray-700">
                                    {FEATURE_ICON[code] ?? '•'} {f.label}
                                  </span>
                                ) : null
                              })
                          }
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-xs truncate max-w-[140px] inline-block" title={r.url}>
                            {(() => { try { return new URL(r.url).pathname } catch { return r.url } })()}
                          </a>
                        ) : <span className="text-gray-700 text-xs">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-10">No keywords match your filters.</p>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
                <span className="text-xs text-gray-500">Page {page} of {totalPages} · {filtered.length} results</span>
                <div className="flex gap-1">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">‹ Prev</button>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="text-xs px-3 py-1 rounded text-gray-400 hover:text-white disabled:opacity-30 transition">Next ›</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {!data && !loading && !error && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-16 text-center">
          <p className="text-4xl mb-3">⭐</p>
          <p className="text-white font-semibold mb-1">Discover your SERP feature footprint</p>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            See which Featured Snippets, PAA boxes, Image Packs, and other SERP features G2G is capturing — and which ones you're missing out on.
          </p>
          <button onClick={runFetch}
            className="mt-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            Run Analysis →
          </button>
        </div>
      )}
    </div>
  )
}
