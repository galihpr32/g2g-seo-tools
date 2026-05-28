'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

/**
 * /backlinks/ga4-analytics — Sprint BACKLINK.GA4.SUMMARY.2
 *
 * Dedicated full-table view of GA4 session data per backlink. The /backlinks
 * page now only shows top 5 + totals to keep that view scannable as the
 * backlink portfolio grows; everything else lives here.
 *
 * Features:
 *   • Date window picker (7d / 30d / 90d) — drives both /analytics call window
 *     and the visual stats
 *   • Sort by any column (sessions desc by default)
 *   • Search across site_name + anchor + URL + campaign
 *   • Status filter (active / broken / pending — but only active have GA4 data)
 *   • CSV export of current filtered view
 *   • Conversion-rate column derived from sessions + conversions
 *
 * Performance: fetches /api/backlinks (all rows) + /api/backlinks/analytics
 * in parallel, joins client-side by id. Total payload ≤ a few KB.
 */

interface Backlink {
  id:              string
  site_name:       string
  anchor_text:     string
  external_url:    string
  target_page:     string
  target_country:  string | null
  link_status:     'active' | 'broken' | 'pending'
  live_date:       string | null
  utm_source:      string | null
  utm_campaign:    string | null
  cost_amount:     number | null
  cost_currency:   string | null
}

interface BacklinkAnalytics {
  id:           string
  site_name:    string
  sessions:     number | null
  conversions:  number | null
}

type SortKey = 'sessions' | 'conversions' | 'conv_rate' | 'site_name' | 'live_date'

const COUNTRY_LABEL: Record<string, string> = {
  global: '🌐 Global', us: '🇺🇸 US', id: '🇮🇩 ID', my: '🇲🇾 MY', sg: '🇸🇬 SG',
  ph: '🇵🇭 PH', th: '🇹🇭 TH', vn: '🇻🇳 VN', br: '🇧🇷 BR', mx: '🇲🇽 MX',
}

export default function BacklinksGa4AnalyticsPage() {
  const [days,     setDays]     = useState<7 | 30 | 90>(30)
  const [backlinks, setBacklinks] = useState<Backlink[]>([])
  const [analyticsMap, setAnalyticsMap] = useState<Map<string, BacklinkAnalytics>>(new Map())
  const [totals,   setTotals]   = useState<{ sessions: number | null; conversions: number | null } | null>(null)
  const [note,     setNote]     = useState<string | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'broken' | 'pending'>('active')
  const [sortKey, setSortKey] = useState<SortKey>('sessions')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // Apply ?days=N from URL on mount
  useEffect(() => {
    if (typeof window === 'undefined') return
    const p = new URLSearchParams(window.location.search)
    const d = parseInt(p.get('days') ?? '')
    if (d === 7 || d === 30 || d === 90) setDays(d as 7 | 30 | 90)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      fetch('/api/backlinks').then(r => r.json()),
      fetch(`/api/backlinks/analytics?days=${days}`).then(r => r.json()),
    ]).then(([blRes, anRes]) => {
      if (cancelled) return
      setBacklinks(blRes.backlinks ?? [])
      const map = new Map<string, BacklinkAnalytics>()
      for (const a of anRes.byBacklink ?? []) map.set(a.id, a)
      setAnalyticsMap(map)
      setTotals(anRes.summary ?? null)
      setNote(anRes.note ?? null)
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [days])

  const enriched = useMemo(() => {
    const s = search.trim().toLowerCase()
    return backlinks
      .filter(b => statusFilter === 'all' || b.link_status === statusFilter)
      .filter(b => {
        if (!s) return true
        return b.site_name.toLowerCase().includes(s)
          || b.anchor_text.toLowerCase().includes(s)
          || b.external_url.toLowerCase().includes(s)
          || b.target_page.toLowerCase().includes(s)
          || (b.utm_campaign ?? '').toLowerCase().includes(s)
      })
      .map(b => {
        const a = analyticsMap.get(b.id)
        const sessions    = a?.sessions ?? null
        const conversions = a?.conversions ?? null
        const conv_rate = (sessions != null && sessions > 0 && conversions != null)
          ? +((conversions / sessions) * 100).toFixed(2)
          : null
        return { ...b, sessions, conversions, conv_rate }
      })
      .sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1
        switch (sortKey) {
          case 'sessions':    return ((a.sessions ?? -1) - (b.sessions ?? -1)) * dir
          case 'conversions': return ((a.conversions ?? -1) - (b.conversions ?? -1)) * dir
          case 'conv_rate':   return ((a.conv_rate ?? -1) - (b.conv_rate ?? -1)) * dir
          case 'site_name':   return a.site_name.localeCompare(b.site_name) * dir
          case 'live_date':   return (a.live_date ?? '').localeCompare(b.live_date ?? '') * dir
        }
      })
  }, [backlinks, analyticsMap, search, statusFilter, sortKey, sortDir])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  function exportCsv() {
    if (enriched.length === 0) return
    const headers = ['Site', 'Anchor', 'Target Page', 'Country', 'Status', 'Live Date', 'UTM Campaign', 'Sessions', 'Conversions', 'Conv Rate %', 'Cost']
    const lines = [headers.join(',')]
    for (const r of enriched) {
      lines.push([
        csv(r.site_name),
        csv(r.anchor_text),
        csv(r.target_page),
        csv(r.target_country ?? ''),
        r.link_status,
        r.live_date ?? '',
        csv(r.utm_campaign ?? ''),
        r.sessions ?? '',
        r.conversions ?? '',
        r.conv_rate ?? '',
        r.cost_amount != null ? `${r.cost_currency ?? ''} ${r.cost_amount}` : '',
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 10)
    a.href = url
    a.download = `backlinks-ga4_${days}d_${stamp}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between mb-5 flex-wrap gap-3">
        <div>
          <Link href="/backlinks" className="text-xs text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-2">
            ← Backlink Tracker
          </Link>
          <h1 className="text-2xl font-bold text-white mb-1">📈 GA4 Click Analytics</h1>
          <p className="text-sm text-gray-400">
            Per-backlink session + conversion data over the last <strong className="text-white">{days} days</strong>.
            Matched via UTM source / sessionSource against external_url domain.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {([7, 30, 90] as const).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`text-xs px-3 py-1.5 rounded-lg transition ${days === d ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={exportCsv}
            disabled={enriched.length === 0}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-xs rounded-lg border border-gray-700"
          >
            ⬇ Export CSV ({enriched.length})
          </button>
        </div>
      </div>

      {note && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2 text-yellow-400 text-xs mb-4">
          {note}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Kpi label={`Total sessions (${days}d)`}      value={totals?.sessions ?? null}         tone="white"   />
        <Kpi label="Total conversions"                value={totals?.conversions ?? null}      tone="green"   />
        <Kpi label="Active backlinks"                 value={backlinks.filter(b => b.link_status === 'active').length} tone="blue" />
        <Kpi label="Backlinks with sessions"          value={Array.from(analyticsMap.values()).filter(a => (a.sessions ?? 0) > 0).length} tone="indigo" />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search site / anchor / URL / campaign…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 min-w-[240px] bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-gray-600"
        />
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as typeof statusFilter)}
          className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-gray-600"
        >
          <option value="active">Active only</option>
          <option value="all">All statuses</option>
          <option value="broken">🔴 Broken</option>
          <option value="pending">🟡 Pending</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sm text-gray-500 py-12 text-center">Loading GA4 data…</p>
      ) : error ? (
        <p className="text-sm text-red-400 py-12 text-center">{error}</p>
      ) : enriched.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-12 text-center">
          <p className="text-3xl mb-3">📈</p>
          <p className="text-white font-semibold mb-1">No backlinks match these filters</p>
          <p className="text-gray-500 text-sm">Try changing status filter or clearing search.</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-950/80 sticky top-0 z-10">
                <tr className="text-gray-500 text-[10px] uppercase tracking-wider">
                  <ThSort label="Site"          k="site_name"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="left" />
                  <th className="px-3 py-2 text-left font-semibold">Anchor</th>
                  <th className="px-3 py-2 text-left font-semibold">Country</th>
                  <ThSort label="Live"          k="live_date"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="left" />
                  <ThSort label="Sessions"      k="sessions"    sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <ThSort label="Conv"          k="conversions" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <ThSort label="Conv %"        k="conv_rate"   sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <th className="px-3 py-2 text-right font-semibold">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {enriched.map(r => (
                  <tr key={r.id} className="border-t border-gray-800 hover:bg-gray-800/30 transition">
                    <td className="px-3 py-2 align-middle text-gray-200 max-w-[180px]">
                      <p className="truncate" title={r.site_name}>{r.site_name}</p>
                      {r.utm_campaign && <p className="text-[9px] text-gray-600 uppercase tracking-wider truncate">{r.utm_campaign}</p>}
                    </td>
                    <td className="px-3 py-2 align-middle text-gray-400 max-w-[200px] truncate" title={r.anchor_text}>
                      {r.anchor_text}
                    </td>
                    <td className="px-3 py-2 align-middle text-[11px] text-gray-400">
                      {COUNTRY_LABEL[r.target_country ?? 'global'] ?? r.target_country ?? '—'}
                    </td>
                    <td className="px-3 py-2 align-middle text-gray-500 font-mono text-[11px]">
                      {r.live_date ?? '—'}
                    </td>
                    <td className="px-3 py-2 align-middle text-right font-mono">
                      {r.sessions == null ? <span className="text-gray-600">—</span> : (
                        <span className={r.sessions > 100 ? 'text-emerald-300' : r.sessions > 0 ? 'text-gray-200' : 'text-gray-500'}>
                          {r.sessions.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-middle text-right font-mono">
                      {r.conversions == null ? <span className="text-gray-600">—</span> : (
                        <span className={r.conversions > 0 ? 'text-emerald-400' : 'text-gray-500'}>
                          {r.conversions}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 align-middle text-right font-mono text-gray-400">
                      {r.conv_rate == null ? '—' : `${r.conv_rate}%`}
                    </td>
                    <td className="px-3 py-2 align-middle text-right">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                        r.link_status === 'active'  ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' :
                        r.link_status === 'broken'  ? 'bg-red-500/15 text-red-300 border-red-500/30' :
                                                       'bg-amber-500/15 text-amber-300 border-amber-500/30'
                      }`}>
                        {r.link_status}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-middle text-right">
                      <a
                        href={r.external_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-blue-400 hover:text-blue-300 whitespace-nowrap"
                      >
                        ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number | null; tone: 'white' | 'green' | 'blue' | 'indigo' }) {
  const toneCls =
    tone === 'green'  ? 'text-emerald-400' :
    tone === 'blue'   ? 'text-blue-300' :
    tone === 'indigo' ? 'text-indigo-300' :
                        'text-white'
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-semibold">{label}</p>
      <p className={`text-2xl font-bold leading-tight ${toneCls}`}>
        {value == null ? '—' : value.toLocaleString()}
      </p>
    </div>
  )
}

function ThSort({ label, k, sortKey, sortDir, onClick, align }: {
  label:   string
  k:       SortKey
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onClick: (k: SortKey) => void
  align:   'left' | 'right'
}) {
  const active = sortKey === k
  return (
    <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'} font-semibold`}>
      <button
        onClick={() => onClick(k)}
        className={`uppercase tracking-wider ${active ? 'text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
      >
        {label}{active && (sortDir === 'desc' ? ' ↓' : ' ↑')}
      </button>
    </th>
  )
}

function csv(s: string): string {
  const str = String(s ?? '')
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}
