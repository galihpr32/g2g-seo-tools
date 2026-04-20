'use client'

import { useState, useMemo } from 'react'

interface PageData {
  path: string
  sessions: number
  engaged: number
  bounce: number
  views: number
  avgDuration: number
}

interface PrevEntry { path: string; sessions: number }

type SortKey = 'sessions' | 'views' | 'avgDuration' | 'mom'

export default function ContentPagesClient({
  currentPages,
  prevEntries,
}: {
  currentPages: PageData[]
  prevEntries: PrevEntry[]
}) {
  const [contains, setContains] = useState('')
  const [excludes, setExcludes] = useState('')
  const [sortKey,  setSortKey]  = useState<SortKey>('sessions')
  const [sortDir,  setSortDir]  = useState<'desc' | 'asc'>('desc')

  const prevMap = useMemo(
    () => new Map(prevEntries.map(e => [e.path, e.sessions])),
    [prevEntries]
  )

  function applyPathFilter(pages: PageData[]) {
    const inc = contains.trim().toLowerCase()
    const exc = excludes.trim().toLowerCase()
    return pages.filter(p => {
      const path = p.path.toLowerCase()
      if (inc && !path.includes(inc)) return false
      if (exc && path.includes(exc)) return false
      return true
    })
  }

  function getMoM(path: string, currentSessions: number) {
    const prev = prevMap.get(path)
    if (!prev || prev === 0) return null
    return ((currentSessions - prev) / prev) * 100
  }

  // ── Decaying: >20% drop ──────────────────────────────────────────────────────
  const decaying = useMemo(() => {
    return applyPathFilter(currentPages)
      .map(p => {
        const prev = prevMap.get(p.path) ?? 0
        if (!prev) return null
        const drop = (prev - p.sessions) / prev
        return drop >= 0.2 ? { ...p, prevSessions: prev, drop } : null
      })
      .filter((x): x is PageData & { prevSessions: number; drop: number } => x !== null)
      .sort((a, b) => b.drop - a.drop)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPages, prevMap, contains, excludes])

  // ── Growing: >10% gain ───────────────────────────────────────────────────────
  const growing = useMemo(() => {
    return applyPathFilter(currentPages)
      .map(p => {
        const prev = prevMap.get(p.path) ?? 0
        if (!prev) return null
        const gain = (p.sessions - prev) / prev
        return gain >= 0.1 ? { ...p, prevSessions: prev, gain } : null
      })
      .filter((x): x is PageData & { prevSessions: number; gain: number } => x !== null)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 10)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPages, prevMap, contains, excludes])

  // ── All pages sorted ─────────────────────────────────────────────────────────
  const allSorted = useMemo(() => {
    const pages = applyPathFilter(currentPages)
    return [...pages].sort((a, b) => {
      let av = 0, bv = 0
      if (sortKey === 'mom') {
        av = getMoM(a.path, a.sessions) ?? -999
        bv = getMoM(b.path, b.sessions) ?? -999
      } else {
        av = a[sortKey]; bv = b[sortKey]
      }
      return sortDir === 'desc' ? bv - av : av - bv
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPages, prevMap, contains, excludes, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  function SortTh({ col, label }: { col: SortKey; label: string }) {
    const active = sortKey === col
    return (
      <th
        onClick={() => toggleSort(col)}
        className="text-right text-gray-500 font-medium px-5 py-3 cursor-pointer select-none hover:text-gray-300 transition whitespace-nowrap"
      >
        {label} {active ? (sortDir === 'desc' ? '↓' : '↑') : <span className="text-gray-700">↕</span>}
      </th>
    )
  }

  return (
    <div className="space-y-8">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
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
        {(contains || excludes) && (
          <button onClick={() => { setContains(''); setExcludes('') }}
            className="text-xs text-gray-500 hover:text-white transition">
            ✕ Clear
          </button>
        )}
      </div>

      {/* Decaying */}
      <div>
        <h2 className="text-white font-semibold mb-3">🔴 Decaying Content — Action Required</h2>
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (now)</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (prev)</th>
                <th className="text-right text-gray-500 font-medium px-5 py-3">Drop</th>
                <th className="text-left text-gray-500 font-medium px-5 py-3">Recommendation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {decaying.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-gray-500">
                  ✅ No decaying content matches current filter
                </td></tr>
              ) : decaying.map((p, i) => {
                const action = p.drop >= 0.5 ? 'Redirect or consolidate' : p.drop >= 0.3 ? 'Full refresh needed' : 'Update & re-promote'
                const actionColor = p.drop >= 0.5 ? 'text-red-400' : p.drop >= 0.3 ? 'text-orange-400' : 'text-yellow-400'
                return (
                  <tr key={i} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3 text-blue-400 max-w-xs truncate font-mono text-xs" title={p.path}>{p.path}</td>
                    <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-400">{p.prevSessions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-red-400 font-semibold">-{Math.round(p.drop * 100)}%</td>
                    <td className={`px-5 py-3 font-medium ${actionColor}`}>{action}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Growing */}
      {growing.length > 0 && (
        <div>
          <h2 className="text-white font-semibold mb-3">🟢 Growing Pages — Momentum to Amplify</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (now)</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions (prev)</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Growth</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {growing.map((p, i) => (
                  <tr key={i} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3 text-blue-400 max-w-xs truncate font-mono text-xs" title={p.path}>{p.path}</td>
                    <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-400">{p.prevSessions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-green-400 font-semibold">+{Math.round(p.gain * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* All tracked pages */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold">All Tracked Pages</h2>
          <span className="text-xs text-gray-500">{allSorted.length} pages</span>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left text-gray-500 font-medium px-5 py-3">Page</th>
                <SortTh col="sessions"    label="Sessions" />
                <SortTh col="views"       label="Views" />
                <SortTh col="avgDuration" label="Avg Duration" />
                <SortTh col="mom"         label="MoM" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {allSorted.length === 0 ? (
                <tr><td colSpan={5} className="px-5 py-8 text-center text-gray-500">No pages match the current filter.</td></tr>
              ) : allSorted.map((p, i) => {
                const mom = getMoM(p.path, p.sessions)
                return (
                  <tr key={i} className="hover:bg-gray-800/50 transition">
                    <td className="px-5 py-3 text-blue-400 max-w-xs truncate font-mono text-xs" title={p.path}>{p.path}</td>
                    <td className="px-5 py-3 text-right text-white">{p.sessions.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{p.views.toLocaleString()}</td>
                    <td className="px-5 py-3 text-right text-gray-300">{Math.round(p.avgDuration)}s</td>
                    <td className={`px-5 py-3 text-right font-medium ${
                      mom === null ? 'text-gray-500' : mom < -20 ? 'text-red-400' : mom > 10 ? 'text-green-400' : 'text-gray-400'
                    }`}>
                      {mom === null ? '—' : `${mom > 0 ? '+' : ''}${mom.toFixed(1)}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
