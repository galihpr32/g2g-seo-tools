'use client'

import { useState, useEffect, useCallback } from 'react'
import ContentPagesClient from './ContentPagesClient'

// ── Date presets ──────────────────────────────────────────────────────────────
const PRESETS = [
  { label: '7 days',  days: 7  },
  { label: '30 days', days: 30 },
  { label: '60 days', days: 60 },
  { label: '90 days', days: 90 },
]

function todayStr() { return new Date().toISOString().split('T')[0] }
function daysAgoStr(n: number) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}

interface PageData { path: string; sessions: number; engaged: number; bounce: number; views: number; avgDuration: number }
interface PrevEntry { path: string; sessions: number }

export default function ContentPerformancePage() {
  const [startDate,     setStartDate]     = useState(daysAgoStr(30))
  const [endDate,       setEndDate]       = useState(daysAgoStr(1))
  const [currentPages,  setCurrentPages]  = useState<PageData[]>([])
  const [prevEntries,   setPrevEntries]   = useState<PrevEntry[]>([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState<string | null>(null)

  const fetchData = useCallback(async (start: string, end: string) => {
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/ga4/content-performance?start=${start}&end=${end}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)
      setCurrentPages(json.currentPages ?? [])
      setPrevEntries(json.prevEntries ?? [])
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

  return (
    <div className="p-8">
      {/* Header + date filter */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">📄 Content Performance</h1>
          <p className="text-gray-400 text-sm mt-1">Page-level engagement, sessions, and MoM trends from GA4</p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex rounded-lg overflow-hidden border border-gray-700">
            {PRESETS.map(p => {
              const start    = daysAgoStr(p.days)
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

      {loading && currentPages.length === 0 && (
        <div className="text-center py-20 text-gray-500">Loading GA4 data…</div>
      )}

      {!loading && !error && currentPages.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500 text-sm">
          No content performance data found for this date range.
        </div>
      )}

      {currentPages.length > 0 && (
        <ContentPagesClient
          currentPages={currentPages}
          prevEntries={prevEntries}
        />
      )}
    </div>
  )
}
