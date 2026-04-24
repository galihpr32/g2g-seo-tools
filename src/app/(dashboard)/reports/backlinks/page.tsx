'use client'

import { useState, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────
interface BacklinkOverview {
  total:           number
  domains:         number
  ips:             number
  subnets:         number
  followLinks:     number
  nofollowLinks:   number
  authorityScore:  number
}

interface ReferringDomain {
  domain:         string
  authorityScore: number
  backlinks:      number
  follows:        number
  noFollows:      number
  firstSeen:      string
  lastSeen:       string
}

interface BacklinkRow {
  sourceUrl:      string
  sourceDomain:   string
  targetUrl:      string
  anchorText:     string
  type:           string
  dofollow:       boolean
  authorityScore: number
  externalLinks:  number
  firstSeen:      string
  lastSeen:       string
}

interface AnchorEntry { anchor: string; count: number }

interface AuditData {
  domain:     string
  overview:   BacklinkOverview | null
  domains:    ReferringDomain[]
  backlinks:  BacklinkRow[]
  topAnchors: AnchorEntry[]
}

// ── Authority score badge ─────────────────────────────────────────────────────
function AScore({ score }: { score: number }) {
  const color = score >= 70 ? 'text-green-400' : score >= 40 ? 'text-yellow-400' : score >= 20 ? 'text-orange-400' : 'text-red-400'
  return <span className={`text-xs font-bold ${color}`}>{score}</span>
}

// ── Toxic heuristic (simple: very low AS + many external links) ───────────────
function toxicScore(row: BacklinkRow): 'low' | 'medium' | 'high' {
  if (row.authorityScore <= 5 && row.externalLinks > 200) return 'high'
  if (row.authorityScore <= 15 && row.externalLinks > 100) return 'medium'
  return 'low'
}

const TOXIC_COLOR = {
  low:    'text-green-400',
  medium: 'text-yellow-400',
  high:   'text-red-400',
}
const TOXIC_LABEL = { low: '✅ Low', medium: '⚠️ Med', high: '🚨 High' }

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BacklinkAuditPage() {
  const [view,    setView]    = useState<'domains' | 'backlinks'>('domains')
  const [limit,   setLimit]   = useState('100')
  const [loading, setLoading] = useState(false)
  const [data,    setData]    = useState<AuditData | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  // Filters
  const [search,    setSearch]    = useState('')
  const [minAS,     setMinAS]     = useState('')
  const [dofollowOnly, setDofollow] = useState(false)
  const [toxicFilter, setToxic]   = useState<'all' | 'high' | 'medium'>('all')
  const [page,      setPage]      = useState(1)
  const PAGE_SIZE = 50

  async function runFetch(nextView = view) {
    setLoading(true); setError(null); setData(null); setPage(1)
    setSearch(''); setMinAS(''); setDofollow(false); setToxic('all')
    try {
      const params = new URLSearchParams({ view: nextView, limit })
      const res  = await fetch(`/api/backlinks/audit?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  function switchView(v: 'domains' | 'backlinks') {
    setView(v)
    if (data) runFetch(v) // re-fetch with new view
  }

  // Filtered referring domains
  const filteredDomains = useMemo(() => {
    if (!data) return []
    let list = data.domains
    if (search.trim()) list = list.filter(r => r.domain.includes(search.trim().toLowerCase()))
    if (minAS && parseInt(minAS) > 0) list = list.filter(r => r.authorityScore >= parseInt(minAS))
    return list.sort((a, b) => b.authorityScore - a.authorityScore)
  }, [data, search, minAS])

  // Filtered backlinks
  const filteredBacklinks = useMemo(() => {
    if (!data) return []
    let list = data.backlinks
    if (search.trim())
      list = list.filter(r => r.sourceDomain.includes(search.trim().toLowerCase()) || r.anchorText.toLowerCase().includes(search.trim().toLowerCase()))
    if (minAS && parseInt(minAS) > 0) list = list.filter(r => r.authorityScore >= parseInt(minAS))
    if (dofollowOnly) list = list.filter(r => r.dofollow)
    if (toxicFilter !== 'all') list = list.filter(r => toxicScore(r) === toxicFilter)
    return list.sort((a, b) => b.authorityScore - a.authorityScore)
  }, [data, search, minAS, dofollowOnly, toxicFilter])

  const activeList    = view === 'domains' ? filteredDomains : filteredBacklinks
  const totalPages    = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE))
  const paginated     = activeList.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const highToxic     = data?.backlinks.filter(r => toxicScore(r) === 'high').length ?? 0

  return (
    <div className="p-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">🔗 Backlink Audit</h1>
        <p className="text-gray-400 text-sm mt-1">
          Analyse G2G's referring domains, anchor text distribution, and toxic link signals via SEMrush.
        </p>
      </div>

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Results to fetch</label>
            <select value={limit} onChange={e => setLimit(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500">
              <option value="50">Top 50</option>
              <option value="100">Top 100</option>
              <option value="250">Top 250</option>
              <option value="500">Top 500</option>
            </select>
          </div>
          <button onClick={() => runFetch()} disabled={loading}
            className="bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            {loading ? '⏳ Loading…' : '🔗 Run Audit'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-3">
          Uses SEMrush <code className="text-gray-500">backlinks_overview</code> + <code className="text-gray-500">backlinks_refdomains</code> / <code className="text-gray-500">backlinks</code> endpoints.
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm">
          <p className="text-red-400 font-medium mb-1">⚠️ {error}</p>
          {(error.includes('403') || error.toLowerCase().includes('access denied') || error.toLowerCase().includes('plan')) && (
            <p className="text-gray-400 mt-1">
              The Backlinks Analytics API requires a SEMrush subscription that includes Backlinks data.
              Verify that <code className="text-gray-300">SEMRUSH_API_KEY</code> is set correctly in your environment and that your plan includes Backlinks API access.
            </p>
          )}
          {error.toLowerCase().includes('not configured') && (
            <p className="text-gray-400 mt-1">
              Set the <code className="text-gray-300">SEMRUSH_API_KEY</code> environment variable to enable backlink audits.
            </p>
          )}
        </div>
      )}

      {loading && (
        <div className="flex justify-center py-16">
          <LottieLoader size={90} text="Fetching backlink data from SEMrush…" />
        </div>
      )}

      {data && !loading && (
        <>
          {/* Overview cards */}
          {data.overview && (
            <div className="grid grid-cols-4 gap-3 mb-6">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-white">{data.overview.authorityScore}</p>
                <p className="text-xs text-gray-500 mt-1">Authority Score</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-white">{data.overview.total.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1">Total backlinks</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-white">{data.overview.domains.toLocaleString()}</p>
                <p className="text-xs text-gray-500 mt-1">Referring domains</p>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
                <div className="flex items-center justify-center gap-3">
                  <div>
                    <p className="text-xl font-bold text-green-400">{data.overview.followLinks.toLocaleString()}</p>
                    <p className="text-[10px] text-gray-500">Dofollow</p>
                  </div>
                  <div className="w-px h-8 bg-gray-700" />
                  <div>
                    <p className="text-xl font-bold text-gray-400">{data.overview.nofollowLinks.toLocaleString()}</p>
                    <p className="text-[10px] text-gray-500">Nofollow</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Anchor text (shown only when backlinks loaded) */}
          {data.topAnchors.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
              <h2 className="text-white font-semibold text-sm mb-3">Top anchor texts</h2>
              <div className="space-y-2">
                {data.topAnchors.map(a => {
                  const pct = Math.round((a.count / data.backlinks.length) * 100)
                  return (
                    <div key={a.anchor} className="flex items-center gap-3">
                      <span className="text-xs text-gray-300 w-48 truncate flex-shrink-0" title={a.anchor}>
                        {a.anchor}
                      </span>
                      <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-red-600/70 rounded-full" style={{ width: `${Math.min(pct * 3, 100)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-16 text-right">{a.count} ({pct}%)</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* High-toxic warning */}
          {highToxic > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-5 flex items-center gap-3">
              <span className="text-2xl">🚨</span>
              <div>
                <p className="text-red-300 font-semibold text-sm">{highToxic} potentially toxic backlink{highToxic !== 1 ? 's' : ''} detected</p>
                <p className="text-gray-400 text-xs mt-0.5">Low authority score + high external link count. Consider disavowing these domains in Google Search Console.</p>
              </div>
            </div>
          )}

          {/* View switcher + table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            {/* Tabs + filters */}
            <div className="p-4 border-b border-gray-800">
              <div className="flex items-center gap-4 mb-3">
                {/* View tabs */}
                <div className="flex rounded-lg overflow-hidden border border-gray-700">
                  <button onClick={() => switchView('domains')}
                    className={`text-xs px-4 py-2 transition ${view === 'domains' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                    Referring Domains ({data.domains.length})
                  </button>
                  <button onClick={() => switchView('backlinks')}
                    className={`text-xs px-4 py-2 transition ${view === 'backlinks' ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
                    Backlinks ({data.backlinks.length})
                  </button>
                </div>
                <span className="text-xs text-gray-500 ml-auto">{activeList.length} results</span>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <input
                  value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
                  placeholder={view === 'domains' ? 'Search domain…' : 'Search domain or anchor…'}
                  className="flex-1 min-w-[180px] max-w-xs bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500"
                />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500">Min AS:</label>
                  <input value={minAS} onChange={e => { setMinAS(e.target.value); setPage(1) }}
                    placeholder="0"
                    className="w-16 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500" />
                </div>
                {view === 'backlinks' && (
                  <>
                    <button onClick={() => { setDofollow(v => !v); setPage(1) }}
                      className={`text-xs px-3 py-2 rounded-lg border transition ${
                        dofollowOnly
                          ? 'bg-green-500/20 border-green-500/40 text-green-300'
                          : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-white'
                      }`}>
                      Dofollow only
                    </button>
                    <div className="flex rounded-lg overflow-hidden border border-gray-700">
                      {(['all', 'high', 'medium'] as const).map(t => (
                        <button key={t} onClick={() => { setToxic(t); setPage(1) }}
                          className={`text-xs px-3 py-1.5 transition ${
                            toxicFilter === t ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'
                          }`}>
                          {t === 'all' ? 'All' : t === 'high' ? '🚨 High risk' : '⚠️ Medium'}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Referring Domains table */}
            {view === 'domains' && (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-800">
                  <tr>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Domain</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">AS</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">Backlinks</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">Dofollow</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">Nofollow</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {(paginated as ReferringDomain[]).map((r, i) => (
                    <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/30 transition">
                      <td className="py-2.5 px-4">
                        <a href={`https://${r.domain}`} target="_blank" rel="noopener noreferrer"
                          className="text-blue-400 hover:text-blue-300 text-xs font-medium">{r.domain}</a>
                      </td>
                      <td className="py-2.5 px-4 text-right"><AScore score={r.authorityScore} /></td>
                      <td className="py-2.5 px-4 text-right text-gray-300 text-xs">{r.backlinks.toLocaleString()}</td>
                      <td className="py-2.5 px-4 text-right text-green-400 text-xs">{r.follows.toLocaleString()}</td>
                      <td className="py-2.5 px-4 text-right text-gray-500 text-xs">{r.noFollows.toLocaleString()}</td>
                      <td className="py-2.5 px-4 text-right text-gray-500 text-xs">
                        {r.firstSeen ? r.firstSeen.split('T')[0] : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* Backlinks table */}
            {view === 'backlinks' && (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-800">
                  <tr>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Source</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-gray-500">Anchor</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">AS</th>
                    <th className="py-3 px-4 text-center text-xs font-medium text-gray-500">Type</th>
                    <th className="py-3 px-4 text-center text-xs font-medium text-gray-500">Toxic</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-gray-500">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {(paginated as BacklinkRow[]).map((r, i) => {
                    const toxic = toxicScore(r)
                    return (
                      <tr key={i} className="border-t border-gray-800 hover:bg-gray-800/30 transition">
                        <td className="py-2.5 px-4 max-w-[200px]">
                          <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 text-xs truncate block" title={r.sourceUrl}>
                            {r.sourceDomain}
                          </a>
                        </td>
                        <td className="py-2.5 px-4 max-w-[200px]">
                          <span className="text-gray-300 text-xs truncate block" title={r.anchorText}>
                            {r.anchorText || <span className="text-gray-600 italic">empty</span>}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right"><AScore score={r.authorityScore} /></td>
                        <td className="py-2.5 px-4 text-center">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            r.dofollow
                              ? 'bg-green-500/15 text-green-300 border-green-500/30'
                              : 'bg-gray-500/15 text-gray-400 border-gray-500/30'
                          }`}>
                            {r.dofollow ? 'dofollow' : 'nofollow'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-center">
                          <span className={`text-xs font-medium ${TOXIC_COLOR[toxic]}`}>
                            {TOXIC_LABEL[toxic]}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right text-gray-500 text-xs">
                          {r.firstSeen ? r.firstSeen.split('T')[0] : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}

            {activeList.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-10">No results match your filters.</p>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-between">
                <span className="text-xs text-gray-500">Page {page} of {totalPages} · {activeList.length} results</span>
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
          <p className="text-4xl mb-3">🔗</p>
          <p className="text-white font-semibold mb-1">Audit G2G's backlink profile</p>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            See referring domains ranked by authority score, anchor text distribution, dofollow vs nofollow split, and flag potentially toxic links.
          </p>
          <button onClick={() => runFetch()}
            className="mt-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition">
            Run Audit →
          </button>
        </div>
      )}
    </div>
  )
}
