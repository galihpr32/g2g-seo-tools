'use client'

// Sprint HUGIN.BASELINE.2 — "Run baseline scan" button + progress banner.
// Lives in the top bar of /hugin. On click → modal with duration picker.
// After start → polls /api/hugin/baseline/[id] every 3s and triggers
// /api/hugin/baseline/tick to drive the chunked job until completion.

import { useCallback, useEffect, useRef, useState } from 'react'

type Status = 'pending' | 'running' | 'aggregating' | 'completed' | 'failed' | 'cancelled'

interface BaselineRun {
  id:                 string
  duration_days:      number
  status:             Status
  total_weeks:        number
  completed_weeks:    number
  total_rows_fetched: number
  error_message:      string | null
  warnings:           string[] | null
  aggregator_result:  { total_upserted?: number; per_window?: unknown[] } | null
  started_at:         string | null
  completed_at:       string | null
}

const DURATIONS = [30, 60, 90, 120, 180] as const

export default function BaselineButton({ onCompleted }: { onCompleted: () => void }) {
  const [open,    setOpen]    = useState(false)
  const [days,    setDays]    = useState<number>(90)
  const [starting, setStarting] = useState(false)
  const [run,     setRun]     = useState<BaselineRun | null>(null)
  const [err,     setErr]     = useState<string | null>(null)

  // Restore in-flight run on mount so refreshing the page doesn't lose progress
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res  = await fetch('/api/hugin/baseline/list?active=1')
        if (!res.ok) return
        const data = await res.json()
        const active = data.runs?.[0]
        if (!cancelled && active && ['pending', 'running', 'aggregating'].includes(active.status)) {
          setRun(active)
        }
      } catch { /* swallow */ }
    })()
    return () => { cancelled = true }
  }, [])

  // Driver loop: when run is in-flight, poll + tick alternately.
  // Each tick processes 1 week. setInterval at 3s gives a chunky but not
  // hammer-y rhythm; the actual tick may take 2-15s depending on GSC traffic.
  const tickInFlight = useRef(false)
  const drive = useCallback(async (runId: string) => {
    if (tickInFlight.current) return
    tickInFlight.current = true
    try {
      const tickRes = await fetch('/api/hugin/baseline/tick', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ run_id: runId }),
      })
      const tickData = await tickRes.json()
      if (tickData.run) {
        setRun(tickData.run as BaselineRun)
        if (tickData.run.status === 'completed') {
          onCompleted()
        }
      }
    } catch (e) {
      console.warn('[hugin-baseline] tick error', e)
    }
    tickInFlight.current = false
  }, [onCompleted])

  useEffect(() => {
    if (!run) return
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return

    const interval = setInterval(() => { drive(run.id) }, 3000)
    return () => clearInterval(interval)
  }, [run, drive])

  async function start() {
    setStarting(true); setErr(null)
    try {
      const res  = await fetch('/api/hugin/baseline/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ duration_days: days }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErr(data.error ?? 'Failed to start')
        setStarting(false)
        return
      }
      // Kick off polling — fetch initial state
      const stateRes = await fetch(`/api/hugin/baseline/${data.run_id}`)
      const state    = await stateRes.json()
      setRun(state.run)
      setOpen(false)
      // Immediately fire first tick instead of waiting 3s
      drive(data.run_id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
    setStarting(false)
  }

  async function cancel() {
    if (!run) return
    if (!confirm('Cancel this baseline scan? Already-fetched data stays in DB.')) return
    await fetch(`/api/hugin/baseline/${run.id}`, { method: 'DELETE' })
    setRun(null)
  }

  function dismissCompleted() {
    setRun(null)
    onCompleted()
  }

  const inFlight = run && ['pending', 'running', 'aggregating'].includes(run.status)

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={!!inFlight}
        className="px-3 py-2 bg-blue-700/40 hover:bg-blue-700/60 disabled:opacity-50 border border-blue-600/50 text-blue-100 text-sm font-medium rounded-lg"
        title={inFlight ? 'Baseline scan already in progress' : 'Backfill GSC history to populate Hugin'}
      >
        🔄 Run baseline scan
      </button>

      {/* Progress banner */}
      {run && (
        <div className="fixed top-2 right-2 left-2 md:left-auto md:max-w-md z-40 rounded-lg border bg-gray-900 shadow-xl"
             style={{ borderColor: run.status === 'failed' ? 'rgb(180,40,40)' : run.status === 'completed' ? 'rgb(40,180,80)' : 'rgb(60,90,180)' }}>
          <div className="p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">
                  {statusIcon(run.status)} Hugin baseline scan ({run.duration_days}d)
                </p>
                <p className="text-[11px] text-gray-400 mt-0.5">{statusDescription(run)}</p>
              </div>
              {(run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') ? (
                <button onClick={dismissCompleted} className="text-gray-400 hover:text-white text-lg leading-none">×</button>
              ) : (
                <button onClick={cancel} className="text-xs text-red-300 hover:text-red-100">Cancel</button>
              )}
            </div>

            {/* Progress bar */}
            {run.total_weeks > 0 && (
              <div className="w-full bg-gray-800 rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-1.5 transition-all duration-500 ${
                    run.status === 'failed' ? 'bg-red-500'
                    : run.status === 'completed' ? 'bg-emerald-500'
                    : 'bg-blue-500'
                  }`}
                  style={{ width: `${Math.min(100, (run.completed_weeks / run.total_weeks) * 100)}%` }}
                />
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-gray-400">
              <span>{run.completed_weeks} / {run.total_weeks} weeks</span>
              <span>{run.total_rows_fetched.toLocaleString()} rows</span>
            </div>

            {run.error_message && (
              <p className="text-[11px] text-red-300 mt-1">{run.error_message}</p>
            )}
            {run.warnings && run.warnings.length > 0 && (
              <details className="text-[11px] text-amber-300">
                <summary className="cursor-pointer hover:text-amber-200">{run.warnings.length} warnings</summary>
                <ul className="mt-1 space-y-0.5 max-h-32 overflow-y-auto">
                  {run.warnings.map((w, i) => <li key={i}>· {w}</li>)}
                </ul>
              </details>
            )}
            {run.status === 'completed' && run.aggregator_result && (
              <p className="text-[11px] text-emerald-300 mt-1">
                ✅ Aggregator wrote {run.aggregator_result.total_upserted ?? 0} hugin_queries rows.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Start modal */}
      {open && !inFlight && (
        <div onClick={() => setOpen(false)} className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div onClick={e => e.stopPropagation()} className="bg-gray-900 border border-gray-700 rounded-lg max-w-md w-full p-5 space-y-3">
            <div className="flex items-start justify-between">
              <h2 className="text-base font-semibold text-white">Run baseline scan</h2>
              <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
            </div>
            <p className="text-xs text-gray-400">
              Backfills GSC search analytics history into <code>gsc_query_snapshots</code>, then runs the long-tail aggregator.
              Use this when you first set up Hugin or after a long gap in cron data.
            </p>
            <div className="space-y-1.5">
              <p className="text-xs text-gray-400">Duration:</p>
              <div className="flex flex-wrap gap-1.5">
                {DURATIONS.map(d => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    className={`px-3 py-1.5 text-xs rounded border ${
                      days === d
                        ? 'border-blue-500 bg-blue-700/30 text-blue-100'
                        : 'border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-gray-500">
                Longer = more historical signals but more API calls.
                ~{Math.ceil(days / 7)} weeks × ~5 sec each = ~{Math.ceil((Math.ceil(days / 7) * 5) / 60)} min total.
              </p>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={start}
                disabled={starting}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded font-medium"
              >
                {starting ? 'Starting…' : `Start scan (${days}d)`}
              </button>
              <button onClick={() => setOpen(false)} className="px-3 py-1.5 text-gray-400 hover:text-white text-sm">Cancel</button>
              {err && <span className="text-xs text-red-400 ml-2">{err}</span>}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function statusIcon(s: Status): string {
  return s === 'pending'     ? '⏳'
       : s === 'running'     ? '🔄'
       : s === 'aggregating' ? '🪶'
       : s === 'completed'   ? '✅'
       : s === 'failed'      ? '❌'
       :                       '🚫'
}

function statusDescription(run: BaselineRun): string {
  if (run.status === 'pending')     return 'Queued, starting next tick…'
  if (run.status === 'running')     return `Fetching week ${run.completed_weeks + 1} of ${run.total_weeks}…`
  if (run.status === 'aggregating') return 'All weeks fetched. Running long-tail aggregator…'
  if (run.status === 'completed')   return `Done in ${formatDuration(run.started_at, run.completed_at)}`
  if (run.status === 'failed')      return `Failed: ${run.error_message ?? 'unknown error'}`
  return 'Cancelled'
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return '?'
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
