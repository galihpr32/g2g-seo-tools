'use client'

import { useState, useMemo } from 'react'

interface PageRow {
  pagePath: string
  sessions: number
  engagedSessions: number
  bounceRate: number
  conversions: number
}

type SortKey = 'sessions' | 'engagedSessions' | 'bounceRate' | 'conversions'

const SORT_LABELS: Record<SortKey, string> = {
  sessions:        'Sessions',
  engagedSessions: 'Engaged',
  bounceRate:      'Bounce',
  conversions:     'Conversions',
}

export default function TopPagesTableClient({ rows }: { rows: PageRow[] }) {
  const [contains, setContains] = useState('')
  const [excludes, setExcludes] = useState('')
  const [sortKey,  setSortKey]  = useState<SortKey>('sessions')
  const [sortDir,  setSortDir]  = useState<'desc' | 'asc'>('desc')

  const filtered = useMemo(() => {
    let out = [...rows]
    const inc = contains.trim().toLowerCase()
    const exc = excludes.trim().toLowerCase()
    if (inc) out = out.filter(r => r.pagePath.toLowerCase().includes(inc))
    if (exc) out = out.filter(r => !r.pagePath.toLowerCase().includes(exc))
    out.sort((a, b) => sortDir === 'desc' ? b[sortKey] - a[sortKey] : a[sortKey] - b[sortKey])
    return out
  }, [rows, contains, excludes, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function SortTh({ col, label, right = true }: { col: SortKey; label: string; right?: boolean }) {
    const active = sortKey === col
    return (
      <th
        onClick={() => toggleSort(col)}
        className={`${right ? 'text-right' : 'text-left'} text-gray-500 font-medium px-5 py-3 cursor-pointer select-none hover:text-gray-300 transition whitespace-nowrap`}
      >
        {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : <span className="text-gray-700">↕</span>}
      </th>
    )
  }

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          type="text"
          value={contains}
          onChange={e => setContains(e.target.value)}
          placeholder="Contains path… (e.g. /categories/)"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-56"
        />
        <input
          type="text"
          value={excludes}
          onChange={e => setExcludes(e.target.value)}
          placeholder="Excludes path… (e.g. /offer/)"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 w-56"
        />
        <span className="text-xs text-gray-600 ml-1">{filtered.length} pages</span>
        {(contains || excludes) && (
          <button
            onClick={() => { setContains(''); setExcludes('') }}
            className="text-xs text-gray-500 hover:text-white transition"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
              <SortTh col="sessions"        label="Sessions" />
              <SortTh col="engagedSessions" label="Engaged" />
              <SortTh col="bounceRate"      label="Bounce" />
              <SortTh col="conversions"     label="Conversions" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  No pages match the current filter.
                </td>
              </tr>
            ) : filtered.map((p, i) => {
              const bounce = p.bounceRate
              return (
                <tr key={i} className="hover:bg-gray-800/50 transition">
                  <td className="px-5 py-3 text-blue-400 max-w-xs truncate font-mono text-xs" title={p.pagePath}>{p.pagePath}</td>
                  <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                  <td className="px-5 py-3 text-right text-gray-300">{p.engagedSessions.toLocaleString()}</td>
                  <td className={`px-5 py-3 text-right ${bounce > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                    {(bounce * 100).toFixed(1)}%
                  </td>
                  <td className="px-5 py-3 text-right text-gray-300">{p.conversions.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
