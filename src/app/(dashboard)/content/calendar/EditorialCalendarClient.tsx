'use client'

import { useState, useMemo, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Brief {
  id:                  string
  page:                string | null
  primary_keyword:     string | null
  brief_type:          string | null
  status:              string | null
  tyr_score:           number | null
  content_outline:     unknown
  target_publish_date: string | null
  created_at:          string | null
  updated_at:          string | null
}

type WriterStatus = 'ready' | 'in_progress' | 'published' | 'draft'

function writerStatus(b: Brief): WriterStatus {
  if (b.status === 'published')      return 'published'
  if (b.status === 'draft')          return 'in_progress'
  if (b.status === 'agent_generated') return 'draft'
  return 'ready'  // 'reviewed'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pathOnly(url: string | null): string {
  if (!url) return ''
  try { return new URL(url).pathname } catch { return url }
}

function titleFor(b: Brief): string {
  return b.primary_keyword || pathOnly(b.page) || 'Untitled'
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function firstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay() // 0=Sun
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DAY_NAMES   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']

// ── Status styles ─────────────────────────────────────────────────────────────

const STATUS_DOT: Record<WriterStatus, string> = {
  ready:       'bg-blue-500',
  in_progress: 'bg-amber-500',
  published:   'bg-green-500',
  draft:       'bg-purple-400',
}

const STATUS_CARD: Record<WriterStatus, string> = {
  ready:       'border-blue-700/60 bg-blue-900/20 hover:border-blue-500',
  in_progress: 'border-amber-700/60 bg-amber-900/20 hover:border-amber-500',
  published:   'border-green-700/60 bg-green-900/20 hover:border-green-500',
  draft:       'border-purple-700/60 bg-purple-900/20 hover:border-purple-500',
}

const STATUS_LABEL: Record<WriterStatus, string> = {
  ready:       'Ready',
  in_progress: 'Writing',
  published:   'Published',
  draft:       'AI Draft',
}

// ── Brief mini-card (in calendar cell) ───────────────────────────────────────

function CalendarBriefChip({
  brief,
  onReschedule,
  onMarkPublished,
  busy,
}: {
  brief: Brief
  onReschedule: (id: string, date: string | null) => Promise<void>
  onMarkPublished: (id: string) => Promise<void>
  busy: string | null
}) {
  const [showActions, setShowActions] = useState(false)
  const ws = writerStatus(brief)

  return (
    <div
      className={`relative text-[10px] rounded border px-1.5 py-1 cursor-pointer transition ${STATUS_CARD[ws]}`}
      onClick={() => setShowActions(s => !s)}
    >
      <div className="flex items-center gap-1">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[ws]}`} />
        <span className="text-gray-200 truncate leading-tight">{titleFor(brief)}</span>
      </div>

      {showActions && (
        <div
          className="absolute left-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 w-56 space-y-2"
          onClick={e => e.stopPropagation()}
        >
          <p className="text-xs text-white font-semibold truncate">{titleFor(brief)}</p>
          <p className="text-[10px] text-gray-500">{STATUS_LABEL[ws]}</p>
          <div className="space-y-1.5 pt-1">
            <a
              href={`/content/briefs/${brief.id}`}
              className="block text-xs px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-center"
            >
              Open brief ↗
            </a>
            {ws !== 'published' && (
              <button
                onClick={() => { onMarkPublished(brief.id); setShowActions(false) }}
                disabled={busy === brief.id}
                className="w-full text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-green-700 text-gray-300 hover:text-white transition disabled:opacity-40"
              >
                ✓ Mark published
              </button>
            )}
            <button
              onClick={() => { onReschedule(brief.id, null); setShowActions(false) }}
              disabled={busy === brief.id}
              className="w-full text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition disabled:opacity-40"
            >
              ✕ Remove from calendar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Pipeline sidebar card ─────────────────────────────────────────────────────

function PipelineCard({
  brief,
  onSchedule,
  busy,
}: {
  brief: Brief
  onSchedule: (id: string, date: string) => Promise<void>
  busy: string | null
}) {
  const [dateInput, setDateInput] = useState('')
  const ws = writerStatus(brief)

  return (
    <div className={`rounded-xl border p-3 transition ${STATUS_CARD[ws]}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[ws]}`} />
        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide">{STATUS_LABEL[ws]}</span>
      </div>
      <a
        href={`/content/briefs/${brief.id}`}
        className="text-xs text-white font-medium hover:text-blue-400 transition line-clamp-2 leading-snug block"
      >
        {titleFor(brief)}
      </a>
      {pathOnly(brief.page) && (
        <p className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{pathOnly(brief.page)}</p>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <input
          type="date"
          value={dateInput}
          onChange={e => setDateInput(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none"
        />
        <button
          onClick={() => dateInput && onSchedule(brief.id, dateInput)}
          disabled={!dateInput || busy === brief.id}
          className="text-[10px] px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition disabled:opacity-40"
        >
          Schedule
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EditorialCalendarClient({ initialBriefs }: { initialBriefs: Brief[] }) {
  const today    = new Date()
  const [year,   setYear]   = useState(today.getFullYear())
  const [month,  setMonth]  = useState(today.getMonth())
  const [briefs, setBriefs] = useState<Brief[]>(initialBriefs)
  const [busy,   setBusy]   = useState<string | null>(null)
  const [view,   setView]   = useState<'month' | 'pipeline'>('month')

  // Map: YYYY-MM-DD → Brief[]
  const calendarMap = useMemo(() => {
    const map = new Map<string, Brief[]>()
    for (const b of briefs) {
      if (!b.target_publish_date) continue
      const key = b.target_publish_date.slice(0, 10)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(b)
    }
    return map
  }, [briefs])

  const unscheduled = useMemo(() =>
    briefs.filter(b => !b.target_publish_date && b.status !== 'published'),
  [briefs])

  // Calendar grid for current month
  const calendarDays = useMemo(() => {
    const days: (number | null)[] = []
    const firstDay = firstDayOfMonth(year, month)
    const total    = daysInMonth(year, month)
    for (let i = 0; i < firstDay; i++) days.push(null)
    for (let d = 1; d <= total; d++) days.push(d)
    // Pad to full weeks
    while (days.length % 7 !== 0) days.push(null)
    return days
  }, [year, month])

  // Stats for the current month
  const monthStats = useMemo(() => {
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`
    const monthBriefs = briefs.filter(b => b.target_publish_date?.startsWith(prefix))
    return {
      total:     monthBriefs.length,
      published: monthBriefs.filter(b => b.status === 'published').length,
      ready:     monthBriefs.filter(b => writerStatus(b) === 'ready').length,
      writing:   monthBriefs.filter(b => writerStatus(b) === 'in_progress').length,
    }
  }, [briefs, year, month])

  const patchBrief = useCallback(async (id: string, patch: Record<string, unknown>) => {
    setBusy(id)
    try {
      const res = await fetch(`/api/content/briefs/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      })
      if (res.ok) {
        setBriefs(prev => prev.map(b => b.id === id ? { ...b, ...patch } : b))
      }
    } finally {
      setBusy(null)
    }
  }, [])

  const handleReschedule  = useCallback((id: string, date: string | null) =>
    patchBrief(id, { target_publish_date: date }), [patchBrief])

  const handleMarkPublished = useCallback((id: string) =>
    patchBrief(id, { status: 'published' }), [patchBrief])

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else setMonth(m => m - 1)
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else setMonth(m => m + 1)
  }
  function goToday() {
    setYear(today.getFullYear())
    setMonth(today.getMonth())
  }

  const todayStr = isoDate(today.getFullYear(), today.getMonth(), today.getDate())

  return (
    <div className="p-6 space-y-4 text-white">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">📅 Editorial Calendar</h1>
          <p className="text-gray-400 text-sm mt-0.5">Schedule and track content briefs</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border border-gray-700 rounded-lg overflow-hidden text-sm">
            <button onClick={() => setView('month')}    className={`px-3 py-1.5 transition ${view === 'month'    ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>🗓 Month</button>
            <button onClick={() => setView('pipeline')} className={`px-3 py-1.5 transition ${view === 'pipeline' ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>⬛ Pipeline</button>
          </div>
        </div>
      </div>

      {/* Month nav + stats */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 transition text-gray-300">‹</button>
          <h2 className="text-lg font-semibold w-44 text-center">{MONTH_NAMES[month]} {year}</h2>
          <button onClick={nextMonth} className="p-2 rounded-lg bg-gray-800 hover:bg-gray-700 transition text-gray-300">›</button>
          <button onClick={goToday}   className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 transition">Today</button>
        </div>
        <div className="flex items-center gap-4 text-xs text-gray-500">
          <span><span className="font-semibold text-white">{monthStats.total}</span> scheduled</span>
          <span><span className="font-semibold text-blue-300">{monthStats.ready}</span> ready</span>
          <span><span className="font-semibold text-amber-300">{monthStats.writing}</span> writing</span>
          <span><span className="font-semibold text-green-300">{monthStats.published}</span> published</span>
          {unscheduled.length > 0 && (
            <span><span className="font-semibold text-gray-300">{unscheduled.length}</span> unscheduled</span>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[10px] text-gray-500">
        {([['ready', 'bg-blue-500', 'Ready to write'], ['in_progress', 'bg-amber-500', 'Writing'], ['published', 'bg-green-500', 'Published'], ['draft', 'bg-purple-400', 'AI Draft']] as const).map(([, dot, label]) => (
          <span key={label} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            {label}
          </span>
        ))}
      </div>

      {/* ── Month view ─────────────────────────────────────────────────── */}
      {view === 'month' && (
        <div className="flex gap-4">
          {/* Calendar grid */}
          <div className="flex-1 min-w-0">
            {/* Day headers */}
            <div className="grid grid-cols-7 gap-px mb-1">
              {DAY_NAMES.map(d => (
                <div key={d} className="text-center text-[10px] font-semibold text-gray-500 py-1">{d}</div>
              ))}
            </div>

            {/* Days */}
            <div className="grid grid-cols-7 gap-px bg-gray-800 rounded-xl overflow-hidden border border-gray-800">
              {calendarDays.map((day, i) => {
                if (!day) return <div key={i} className="bg-gray-950 min-h-[80px]" />

                const dateStr    = isoDate(year, month, day)
                const dayBriefs  = calendarMap.get(dateStr) ?? []
                const isToday    = dateStr === todayStr
                const isPast     = dateStr < todayStr

                return (
                  <div
                    key={i}
                    className={`min-h-[80px] p-1.5 relative flex flex-col ${
                      isToday ? 'bg-red-950/30' :
                      isPast  ? 'bg-gray-900/50' :
                               'bg-gray-900'
                    }`}
                  >
                    <span className={`text-xs font-semibold mb-1 w-5 h-5 flex items-center justify-center rounded-full ${
                      isToday ? 'bg-red-600 text-white' : isPast ? 'text-gray-600' : 'text-gray-400'
                    }`}>
                      {day}
                    </span>
                    <div className="space-y-0.5 flex-1">
                      {dayBriefs.map(b => (
                        <CalendarBriefChip
                          key={b.id}
                          brief={b}
                          onReschedule={handleReschedule}
                          onMarkPublished={handleMarkPublished}
                          busy={busy}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Unscheduled pipeline */}
          {unscheduled.length > 0 && (
            <div className="w-56 flex-shrink-0">
              <p className="text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wide">
                Unscheduled ({unscheduled.length})
              </p>
              <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                {unscheduled.map(b => (
                  <PipelineCard
                    key={b.id}
                    brief={b}
                    onSchedule={handleReschedule}
                    busy={busy}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Pipeline view ──────────────────────────────────────────────── */}
      {view === 'pipeline' && (
        <div className="grid grid-cols-4 gap-4">
          {([
            ['draft',       'AI Draft',   'bg-purple-900/20 border-purple-800/40'],
            ['ready',       'Ready',      'bg-blue-900/20 border-blue-800/40'],
            ['in_progress', 'Writing',    'bg-amber-900/20 border-amber-800/40'],
            ['published',   'Published',  'bg-green-900/20 border-green-800/40'],
          ] as const).map(([ws, label, style]) => {
            const col = briefs.filter(b => writerStatus(b) === ws)
            return (
              <div key={ws} className={`rounded-2xl border p-4 ${style}`}>
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                  {label}
                  <span className="ml-2 text-gray-600 font-normal">{col.length}</span>
                </p>
                <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
                  {col.map(b => (
                    <div key={b.id} className="bg-gray-900 rounded-xl border border-gray-800 p-3 hover:border-gray-700 transition">
                      <a
                        href={`/content/briefs/${b.id}`}
                        className="text-xs text-white font-medium hover:text-blue-400 transition block leading-snug"
                      >
                        {titleFor(b)}
                      </a>
                      {pathOnly(b.page) && (
                        <p className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{pathOnly(b.page)}</p>
                      )}
                      {b.target_publish_date ? (
                        <p className="text-[10px] text-gray-500 mt-1.5">📅 {b.target_publish_date}</p>
                      ) : ws !== 'published' ? (
                        <div className="mt-1.5 flex items-center gap-1">
                          <input
                            type="date"
                            className="flex-1 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:outline-none"
                            onChange={e => e.target.value && handleReschedule(b.id, e.target.value)}
                          />
                        </div>
                      ) : null}
                      {ws !== 'published' && (
                        <button
                          onClick={() => handleMarkPublished(b.id)}
                          disabled={busy === b.id}
                          className="mt-1.5 w-full text-[10px] px-2 py-1 rounded bg-gray-800 hover:bg-green-700 text-gray-500 hover:text-white transition disabled:opacity-40"
                        >
                          ✓ Mark published
                        </button>
                      )}
                    </div>
                  ))}
                  {col.length === 0 && (
                    <p className="text-[10px] text-gray-700 text-center py-6">No briefs here</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
