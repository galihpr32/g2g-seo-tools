'use client'

import { useState, useEffect, useMemo } from 'react'
import { LottieLoader } from '@/components/ui/LottieLoader'

// ── Types ─────────────────────────────────────────────────────────────────────

interface InboundLink {
  from: string
  anchor: string | null
  dofollow: boolean
}

interface BrokenPage {
  url: string
  path: string
  status_code: number
  title: string
  inlinks_count: number
  inlinks: InboundLink[]
  historical_impressions: number
  historical_clicks: number
  historical_position: number | null
  lost_impressions: number
  severity: 'error' | 'broken'
}

interface LostPage {
  url: string
  path: string
  historical_impressions: number
  historical_clicks: number
  historical_position: number | null
  inlinks_count: number
  inlinks: InboundLink[]
  status_code: number | null
}

interface BrokenLink {
  dest_url: string
  dest_path: string
  anchor: string | null
  status_code: number | null
}

interface OutlinkRow {
  source_url: string
  source_path: string
  source_title: string
  broken_links: BrokenLink[]
}

interface Summary {
  hasCrawl: boolean
  hasGSC: boolean
  crawledPages: number
  brokenCount: number
  lostPageCount: number
  brokenOutlinkPages: number
  totalBrokenOutlinks: number
  totalLostImpressions: number
  error5xxCount: number
  error4xxCount: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(code: number | null) {
  if (!code) return <span className="text-gray-600 text-[10px]">unknown</span>
  const color = code >= 500
    ? 'bg-purple-900/50 text-purple-300 border-purple-800'
    : code >= 400
      ? 'bg-red-900/50 text-red-300 border-red-800'
      : 'bg-gray-800 text-gray-400 border-gray-700'
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${color}`}>{code}</span>
}

function fmtNum(n: number) {
  if (!n) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(n)
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={e => {
        e.stopPropagation()
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="text-[10px] text-gray-600 hover:text-gray-400 transition ml-1"
      title="Copy URL"
    >{copied ? '✓' : '⎘'}</button>
  )
}

// ── BrokenCard ────────────────────────────────────────────────────────────────
function BrokenCard({ page: p }: { page: BrokenPage }) {
  const [expanded, setExpanded] = useState(false)
  const is5xx = p.status_code >= 500
  const hasHistory = p.historical_impressions > 0

  return (
    <div className={`border rounded-xl overflow-hidden transition ${
      is5xx ? 'bg-purple-900/20 border-purple-800/40' : 'bg-red-900/15 border-red-800/40'
    }`}>
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-white/5 transition"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Status code */}
        <div className="flex-shrink-0">{statusBadge(p.status_code)}</div>

        {/* Path + title */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white text-xs font-medium font-mono truncate max-w-[360px]">{p.path}</span>
            <CopyButton text={p.url} />
            {p.inlinks_count > 0 && (
              <span className="text-[10px] text-yellow-400 flex-shrink-0">
                {p.inlinks_count} page{p.inlinks_count !== 1 ? 's' : ''} link here
              </span>
            )}
          </div>
          {p.title && <p className="text-gray-500 text-[10px] truncate mt-0.5">{p.title}</p>}
        </div>

        {/* GSC loss */}
        {hasHistory && (
          <div className="text-right flex-shrink-0 hidden md:block">
            <p className="text-orange-400 text-xs font-semibold">{fmtNum(p.historical_impressions)}</p>
            <p className="text-gray-600 text-[10px]">lost impr</p>
          </div>
        )}

        <span className="text-gray-600 text-xs flex-shrink-0">{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="border-t border-gray-700/40 px-4 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Historical GSC data */}
          <div>
            <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">
              Historical performance (61–90d ago)
            </p>
            {hasHistory ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className="text-orange-400 font-semibold text-sm">{fmtNum(p.historical_impressions)}</p>
                  <p className="text-gray-600 text-[10px]">impressions</p>
                </div>
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className="text-blue-400 font-semibold text-sm">{fmtNum(p.historical_clicks)}</p>
                  <p className="text-gray-600 text-[10px]">clicks</p>
                </div>
                <div className="bg-gray-900/60 rounded-lg p-2 text-center">
                  <p className="text-green-400 font-semibold text-sm">
                    {p.historical_position ? `#${p.historical_position.toFixed(1)}` : '—'}
                  </p>
                  <p className="text-gray-600 text-[10px]">position</p>
                </div>
              </div>
            ) : (
              <p className="text-gray-600 text-xs">No historical GSC data — page may never have been indexed.</p>
            )}

            {/* Fix suggestion */}
            <div className="mt-3 bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2">
              <p className="text-blue-400 text-[10px] font-semibold uppercase mb-1">Fix in your CMS</p>
              <p className="text-gray-400 text-xs leading-relaxed">
                {is5xx
                  ? 'Server error — check your CMS/hosting configuration. This may be a broken route or missing template.'
                  : hasHistory
                    ? `This URL had ${fmtNum(p.historical_impressions)} impressions before going dark. Set up a 301 redirect in your CMS to preserve link equity.`
                    : 'Set up a 301 redirect in your CMS, or remove all internal links pointing to this URL.'}
              </p>
            </div>
          </div>

          {/* Inbound links */}
          <div>
            <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">
              Pages linking here ({p.inlinks_count})
            </p>
            {p.inlinks.length === 0 ? (
              <p className="text-gray-600 text-xs">No internal pages link to this URL — safe to ignore if not in sitemap.</p>
            ) : (
              <div className="space-y-1.5">
                {p.inlinks.map((link, i) => (
                  <div key={i} className="bg-gray-900/60 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${link.dofollow ? 'bg-green-500' : 'bg-gray-600'}`} />
                      <a
                        href={link.from}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-[10px] font-mono truncate max-w-[220px] transition"
                        onClick={e => e.stopPropagation()}
                      >{link.from}</a>
                    </div>
                    {link.anchor && (
                      <p className="text-gray-600 text-[10px] mt-0.5 ml-3">anchor: "{link.anchor}"</p>
                    )}
                  </div>
                ))}
                {p.inlinks_count > p.inlinks.length && (
                  <p className="text-gray-700 text-[10px]">+{p.inlinks_count - p.inlinks.length} more</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── LostPageRow ───────────────────────────────────────────────────────────────
function LostPageRow({ page: p }: { page: LostPage }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border-t border-gray-800/60">
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-800/20 transition"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-orange-500 text-xs flex-shrink-0">👻</span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-gray-200 text-xs font-mono truncate max-w-[360px]">{p.path}</span>
            <CopyButton text={p.url} />
            {p.inlinks_count > 0 && (
              <span className="text-[10px] text-yellow-400 flex-shrink-0">{p.inlinks_count} inlinks</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          <div className="text-right">
            <p className="text-orange-400 text-xs font-semibold">{fmtNum(p.historical_impressions)}</p>
            <p className="text-gray-600 text-[10px]">impr 61–90d ago</p>
          </div>
          <div className="text-right">
            <p className="text-blue-400 text-xs font-semibold">{fmtNum(p.historical_clicks)}</p>
            <p className="text-gray-600 text-[10px]">clicks</p>
          </div>
          <div className="text-right">
            <p className="text-gray-400 text-xs">
              {p.historical_position ? `#${p.historical_position.toFixed(1)}` : '—'}
            </p>
            <p className="text-gray-600 text-[10px]">position</p>
          </div>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && p.inlinks.length > 0 && (
        <div className="px-4 pb-3 border-t border-gray-800/40">
          <p className="text-gray-600 text-[10px] font-semibold uppercase tracking-wider mt-2 mb-2">
            Still linked from:
          </p>
          <div className="space-y-1">
            {p.inlinks.map((link, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${link.dofollow ? 'bg-green-500' : 'bg-gray-600'}`} />
                <a
                  href={link.from}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 text-[10px] font-mono truncate transition"
                  onClick={e => e.stopPropagation()}
                >{link.from}</a>
                {link.anchor && <span className="text-gray-700 text-[10px]">"{link.anchor}"</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── OutlinkCard ───────────────────────────────────────────────────────────────
function OutlinkCard({ row }: { row: OutlinkRow }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-gray-900 border border-yellow-800/30 rounded-xl overflow-hidden">
      <div
        className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-800/30 transition"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-yellow-500 text-xs flex-shrink-0">⚠️</span>
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-medium truncate max-w-[380px]">
            {row.source_title || row.source_path}
          </p>
          <p className="text-gray-600 text-[10px] font-mono">{row.source_path}</p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-yellow-400 text-xs font-semibold">
            {row.broken_links.length} broken link{row.broken_links.length !== 1 ? 's' : ''}
          </span>
          <span className="text-gray-600 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-800 px-4 py-3">
          <p className="text-gray-500 text-[10px] font-semibold uppercase tracking-wider mb-2">
            Broken destinations
          </p>
          <div className="space-y-2">
            {row.broken_links.map((link, i) => (
              <div key={i} className="bg-gray-800/60 rounded-lg px-3 py-2 flex items-center gap-3">
                <div className="flex-shrink-0">{statusBadge(link.status_code)}</div>
                <div className="flex-1 min-w-0">
                  <p className="text-gray-300 text-[10px] font-mono truncate">{link.dest_path}</p>
                  {link.anchor && (
                    <p className="text-gray-600 text-[10px]">anchor: "{link.anchor}"</p>
                  )}
                </div>
                <CopyButton text={link.dest_url} />
              </div>
            ))}
          </div>
          <div className="mt-3 bg-blue-950/30 border border-blue-900/40 rounded-lg px-3 py-2">
            <p className="text-blue-400 text-[10px] font-semibold uppercase mb-1">Fix</p>
            <p className="text-gray-400 text-xs">
              Edit <span className="font-mono text-white">{row.source_path}</span> in your CMS and update or remove these {row.broken_links.length} broken link{row.broken_links.length !== 1 ? 's' : ''}.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'broken' | 'lost' | 'outlinks'

export default function BrokenUrlsPage() {
  const [data, setData]       = useState<{
    summary: Summary
    broken: BrokenPage[]
    lostPages: LostPage[]
    brokenOutlinks: OutlinkRow[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [tab,     setTab]     = useState<Tab>('broken')

  // Filters
  const [searchBroken,   setSearchBroken]   = useState('')
  const [statusFilter,   setStatusFilter]   = useState<'all' | '4xx' | '5xx'>('all')
  const [searchLost,     setSearchLost]     = useState('')
  const [searchOutlinks, setSearchOutlinks] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res  = await fetch('/api/broken-urls')
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Failed to load'); return }
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const filteredBroken = useMemo(() => {
    if (!data) return []
    let list = data.broken
    if (statusFilter === '4xx') list = list.filter(p => p.status_code < 500)
    if (statusFilter === '5xx') list = list.filter(p => p.status_code >= 500)
    if (searchBroken.trim()) {
      const q = searchBroken.toLowerCase()
      list = list.filter(p => p.path.includes(q) || p.title.toLowerCase().includes(q))
    }
    return list
  }, [data, statusFilter, searchBroken])

  const filteredLost = useMemo(() => {
    if (!data) return []
    let list = data.lostPages
    if (searchLost.trim()) {
      const q = searchLost.toLowerCase()
      list = list.filter(p => p.path.includes(q))
    }
    return list
  }, [data, searchLost])

  const filteredOutlinks = useMemo(() => {
    if (!data) return []
    let list = data.brokenOutlinks
    if (searchOutlinks.trim()) {
      const q = searchOutlinks.toLowerCase()
      list = list.filter(r => r.source_path.includes(q) || r.source_title.toLowerCase().includes(q))
    }
    return list
  }, [data, searchOutlinks])

  if (loading) return (
    <div className="flex items-center justify-center h-full py-32">
      <LottieLoader size={80} text="Scanning for broken URLs…" />
    </div>
  )

  if (error) return (
    <div className="p-8">
      <div className="bg-red-900/30 border border-red-700 rounded-xl px-5 py-4 text-red-300 text-sm">{error}</div>
    </div>
  )

  if (!data) return null
  const { summary } = data

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-white font-bold text-xl">Broken URL Monitor</h1>
          <p className="text-gray-500 text-sm mt-1">
            4xx/5xx pages · ghost pages that vanished from GSC · live pages with broken outlinks
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Data source indicators */}
          <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <span className={`w-1.5 h-1.5 rounded-full ${summary.hasCrawl ? 'bg-green-500' : 'bg-gray-700'}`} />
            Crawl
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <span className={`w-1.5 h-1.5 rounded-full ${summary.hasGSC ? 'bg-green-500' : 'bg-gray-700'}`} />
            GSC
          </div>
          <button
            onClick={load}
            className="text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 hover:text-white px-3 py-1.5 rounded-lg transition ml-2"
          >↺ Refresh</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-gray-500 text-xs mb-1">Pages crawled</p>
          <p className="text-white font-bold text-xl">{summary.crawledPages.toLocaleString()}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.error4xxCount > 0 ? 'bg-red-900/20 border-red-800/40' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">🔴 4xx broken</p>
          <p className={`font-bold text-xl ${summary.error4xxCount > 0 ? 'text-red-400' : 'text-gray-400'}`}>{summary.error4xxCount}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.error5xxCount > 0 ? 'bg-purple-900/20 border-purple-800/40' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">🟣 5xx errors</p>
          <p className={`font-bold text-xl ${summary.error5xxCount > 0 ? 'text-purple-400' : 'text-gray-400'}`}>{summary.error5xxCount}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.lostPageCount > 0 ? 'bg-orange-900/20 border-orange-800/30' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">👻 Lost from GSC</p>
          <p className={`font-bold text-xl ${summary.lostPageCount > 0 ? 'text-orange-400' : 'text-gray-400'}`}>{summary.lostPageCount}</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.totalBrokenOutlinks > 0 ? 'bg-yellow-900/20 border-yellow-800/30' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">⚠️ Broken outlinks</p>
          <p className={`font-bold text-xl ${summary.totalBrokenOutlinks > 0 ? 'text-yellow-400' : 'text-gray-400'}`}>{summary.totalBrokenOutlinks}</p>
          <p className="text-gray-600 text-[10px]">across {summary.brokenOutlinkPages} pages</p>
        </div>
        <div className={`border rounded-xl p-4 ${summary.totalLostImpressions > 0 ? 'bg-orange-900/20 border-orange-800/30' : 'bg-gray-900 border-gray-800'}`}>
          <p className="text-gray-500 text-xs mb-1">Est. lost impressions</p>
          <p className={`font-bold text-xl ${summary.totalLostImpressions > 0 ? 'text-orange-400' : 'text-gray-400'}`}>{fmtNum(summary.totalLostImpressions)}</p>
          <p className="text-gray-600 text-[10px]">from broken pages</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 mb-5 w-fit">
        {([
          { key: 'broken',   label: `🔴 Broken Pages (${summary.brokenCount})` },
          { key: 'lost',     label: `👻 Lost from GSC (${summary.lostPageCount})` },
          { key: 'outlinks', label: `⚠️ Broken Outlinks (${summary.totalBrokenOutlinks})` },
        ] as const).map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition ${tab === t.key ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >{t.label}</button>
        ))}
      </div>

      {/* ── Tab: Broken Pages ─────────────────────────────────────────────────── */}
      {tab === 'broken' && (
        <div>
          <div className="mb-4 flex items-start gap-2 text-xs bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-blue-500 flex-shrink-0">ℹ</span>
            <span className="text-gray-600">
              Pages returning 4xx or 5xx status during the last site crawl. Sorted by historical impressions — pages that used to get traffic are most urgent to fix in your CMS.
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <input
              type="text"
              value={searchBroken}
              onChange={e => setSearchBroken(e.target.value)}
              placeholder="Search path or title…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-64"
            />
            <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
              {([['all', 'All'], ['4xx', '4xx'], ['5xx', '5xx']] as const).map(([v, l]) => (
                <button
                  key={v}
                  onClick={() => setStatusFilter(v)}
                  className={`px-3 py-1 text-xs rounded-md transition ${statusFilter === v ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
                >{l}</button>
              ))}
            </div>
            <span className="text-gray-600 text-xs ml-auto">{filteredBroken.length} pages</span>
          </div>

          {filteredBroken.length === 0 ? (
            <EmptyState icon="✅" title="No broken pages found" sub={summary.hasCrawl ? 'All crawled pages returned 2xx status' : 'Run a site audit to detect broken pages'} />
          ) : (
            <div className="space-y-2">
              {filteredBroken.map(p => <BrokenCard key={p.url} page={p} />)}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Lost from GSC ────────────────────────────────────────────────── */}
      {tab === 'lost' && (
        <div>
          <div className="mb-4 flex items-start gap-2 text-xs bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-blue-500 flex-shrink-0">ℹ</span>
            <span className="text-gray-600">
              Pages with ≥20 impressions in GSC 61–90 days ago that now have <span className="text-white">zero impressions</span> in the last 7 days. These pages have gone dark — Google can no longer reach or rank them. Sorted by historical impressions lost.
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={searchLost}
              onChange={e => setSearchLost(e.target.value)}
              placeholder="Search path…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-64"
            />
            <span className="text-gray-600 text-xs ml-auto">{filteredLost.length} pages</span>
          </div>

          {!summary.hasGSC ? (
            <EmptyState icon="🔌" title="GSC not connected" sub="Connect Google Search Console to detect lost pages" />
          ) : filteredLost.length === 0 ? (
            <EmptyState icon="✅" title="No lost pages detected" sub="All pages with significant historical impressions are still visible in GSC" />
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 bg-gray-800/40 border-b border-gray-800 grid grid-cols-[1fr_80px_80px_80px_60px] gap-3">
                <span className="text-gray-500 text-xs font-medium">Page</span>
                <span className="text-gray-500 text-xs font-medium text-right">Impr (old)</span>
                <span className="text-gray-500 text-xs font-medium text-right">Clicks (old)</span>
                <span className="text-gray-500 text-xs font-medium text-right">Position</span>
                <span className="text-gray-500 text-xs font-medium text-right">Inlinks</span>
              </div>
              {filteredLost.map(p => <LostPageRow key={p.url} page={p} />)}
            </div>
          )}
        </div>
      )}

      {/* ── Tab: Broken Outlinks ──────────────────────────────────────────────── */}
      {tab === 'outlinks' && (
        <div>
          <div className="mb-4 flex items-start gap-2 text-xs bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
            <span className="text-blue-500 flex-shrink-0">ℹ</span>
            <span className="text-gray-600">
              Live pages that contain internal links pointing to broken destinations. Fix these links in your CMS — edit the page and update or remove the broken anchor.
            </span>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <input
              type="text"
              value={searchOutlinks}
              onChange={e => setSearchOutlinks(e.target.value)}
              placeholder="Search source page…"
              className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-red-500 w-64"
            />
            <span className="text-gray-600 text-xs ml-auto">{filteredOutlinks.length} pages</span>
          </div>

          {!summary.hasCrawl ? (
            <EmptyState icon="🔍" title="No crawl data" sub="Run a site audit to detect broken outlinks" />
          ) : filteredOutlinks.length === 0 ? (
            <EmptyState icon="✅" title="No broken outlinks found" sub="All internal links on crawled pages point to live destinations" />
          ) : (
            <div className="space-y-2">
              {filteredOutlinks.map(r => <OutlinkCard key={r.source_url} row={r} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function EmptyState({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-16 text-center">
      <p className="text-3xl mb-3">{icon}</p>
      <p className="text-gray-400 text-sm font-medium">{title}</p>
      <p className="text-gray-600 text-xs mt-1">{sub}</p>
    </div>
  )
}
