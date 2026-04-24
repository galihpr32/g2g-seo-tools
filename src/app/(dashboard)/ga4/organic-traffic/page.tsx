'use client'

import { useState, useEffect, useCallback } from 'react'
import TopPagesTableClient from './TopPagesTableClient'

// ── Date presets ──────────────────────────────────────────────────────────────
const PRESETS = [
  { label: '7 days',  days: 7  },
  { label: '14 days', days: 14 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
]

function todayStr() { return new Date().toISOString().split('T')[0] }
function daysAgoStr(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface GA4Data {
  sessions:        number
  prevSessions:    number
  sessionsDiff:    number | null
  totalUsers:      number
  prevTotalUsers:  number
  usersDiff:       number | null
  newUsers:        number
  engagedSessions: number
  pageViews:       number
  avgBounce:       number
  engagementRate:  number
  dailyRows:       Record<string, string>[]
  organicPageRows: { pagePath: string; sessions: number; engagedSessions: number; bounceRate: number; conversions: number }[]
}

export default function OrganicTrafficPage() {
  const [startDate, setStartDate] = useState(daysAgoStr(7))
  const [endDate,   setEndDate]   = useState(daysAgoStr(1))
  const [data,      setData]      = useState<GA4Data | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)

  const fetchData = useCallback(async (start: string, end: string) => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/ga4/organic-traffic?start=${start}&end=${end}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setData(json)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData(startDate, endDate) }, []) // eslint-disable-line

  function applyPreset(days: number) {
    const start = daysAgoStr(days)
    const end   = daysAgoStr(1)
    setStartDate(start)
    setEndDate(end)
    fetchData(start, end)
  }

  function applyCustom() { fetchData(startDate, endDate) }

  const d = data

  return (
    <div className="p-8">
      {/* Header + date filter */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">📈 Organic Traffic Analysis</h1>
          <p className="text-gray-400 text-sm mt-1">GA4 organic sessions, engagement rate and top landing pages</p>
        </div>

        {/* Date range controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Presets */}
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {PRESETS.map(p => {
              const start = daysAgoStr(p.days)
              const isActive = startDate === start && endDate === daysAgoStr(1)
              return (
                <button
                  key={p.days}
                  onClick={() => applyPreset(p.days)}
                  className={`text-xs px-3 py-1.5 transition ${
                    isActive ? 'bg-red-700 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          {/* Custom date inputs */}
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={e => setStartDate(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
          />
          <span className="text-gray-600 text-xs">→</span>
          <input
            type="date"
            value={endDate}
            min={startDate}
            max={todayStr()}
            onChange={e => setEndDate(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
          />
          <button
            onClick={applyCustom}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-white transition disabled:opacity-50"
          >
            {loading ? '⏳' : 'Apply'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-6 text-sm text-red-400">
          ⚠️ {error}
          {error.includes('not configured') && (
            <p className="text-gray-400 text-xs mt-1">
              Ensure GA4_PROPERTY_ID is set and Google is connected in Settings.
            </p>
          )}
        </div>
      )}

      {loading && !d && (
        <div className="text-center py-20 text-gray-500">Loading GA4 data…</div>
      )}

      {d && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-5 gap-4 mb-8">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Organic Sessions</p>
              <p className="text-3xl font-bold text-white">{d.sessions > 0 ? d.sessions.toLocaleString() : '—'}</p>
              {d.sessionsDiff !== null && (
                <p className={`text-sm mt-1 font-medium ${d.sessionsDiff < 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {d.sessionsDiff > 0 ? '+' : ''}{d.sessionsDiff.toFixed(1)}% vs prev
                </p>
              )}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Total Users</p>
              <p className="text-3xl font-bold text-white">{d.totalUsers > 0 ? d.totalUsers.toLocaleString() : '—'}</p>
              {d.usersDiff !== null && (
                <p className={`text-sm mt-1 font-medium ${d.usersDiff < 0 ? 'text-red-400' : 'text-green-400'}`}>
                  {d.usersDiff > 0 ? '+' : ''}{d.usersDiff.toFixed(1)}% vs prev
                </p>
              )}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">New Users</p>
              <p className="text-3xl font-bold text-white">{d.newUsers > 0 ? d.newUsers.toLocaleString() : '—'}</p>
              {d.totalUsers > 0 && d.newUsers > 0 && (
                <p className="text-xs mt-1 text-gray-500">{Math.round((d.newUsers / d.totalUsers) * 100)}% of total</p>
              )}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Engagement Rate</p>
              <p className="text-3xl font-bold text-white">{d.engagementRate > 0 ? `${d.engagementRate.toFixed(1)}%` : '—'}</p>
              <p className="text-xs mt-1 text-gray-500">{d.engagedSessions > 0 ? `${d.engagedSessions.toLocaleString()} engaged` : 'engaged sessions'}</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
              <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">Page Views</p>
              <p className="text-3xl font-bold text-white">{d.pageViews > 0 ? d.pageViews.toLocaleString() : '—'}</p>
              <p className={`text-xs mt-1 ${d.avgBounce > 0.6 ? 'text-red-400' : 'text-gray-500'}`}>
                {d.avgBounce > 0 ? `${(d.avgBounce * 100).toFixed(1)}% bounce` : ''}
              </p>
            </div>
          </div>

          {/* Daily trend */}
          <h2 className="text-white font-semibold mb-3">Daily Breakdown</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left text-gray-500 font-medium px-5 py-3">Date</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Sessions</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Total Users</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">New Users</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Engaged</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Page Views</th>
                  <th className="text-right text-gray-500 font-medium px-5 py-3">Bounce Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {d.dailyRows.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-8 text-center text-gray-500">No data for this range</td>
                  </tr>
                ) : d.dailyRows.map((row, i) => {
                  const dateStr = row.date ? `${row.date.slice(0,4)}-${row.date.slice(4,6)}-${row.date.slice(6,8)}` : '—'
                  const bounce  = parseFloat(row.bounceRate ?? '0')
                  const isLatest = i === d.dailyRows.length - 1
                  return (
                    <tr key={i} className={`hover:bg-gray-800/50 transition ${isLatest ? 'bg-blue-900/10' : ''}`}>
                      <td className="px-5 py-3 text-gray-300">
                        {dateStr}
                        {isLatest && <span className="text-xs text-blue-400 ml-2">latest</span>}
                      </td>
                      <td className="px-5 py-3 text-right text-white">{parseInt(row.sessions ?? '0').toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-300">{parseInt(row.totalUsers ?? '0').toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-500">{parseInt(row.newUsers ?? '0').toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-300">{parseInt(row.engagedSessions ?? '0').toLocaleString()}</td>
                      <td className="px-5 py-3 text-right text-gray-300">{parseInt(row.screenPageViews ?? '0').toLocaleString()}</td>
                      <td className={`px-5 py-3 text-right ${bounce > 0.6 ? 'text-red-400' : 'text-gray-300'}`}>
                        {(bounce * 100).toFixed(1)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Top organic landing pages */}
          <h2 className="text-white font-semibold mb-3">
            Top Organic Landing Pages
            <span className="text-gray-500 font-normal text-sm ml-2">
              ({startDate} → {endDate})
            </span>
          </h2>
          {d.organicPageRows.length === 0 ? (
            <div className="bg-gray-900 rounded-xl border border-gray-800 p-8 text-center text-gray-500 text-sm">
              No organic landing page data found
            </div>
          ) : (
            <TopPagesTableClient rows={d.organicPageRows} />
          )}
        </>
      )}
    </div>
  )
}
