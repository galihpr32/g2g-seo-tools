'use client'

import { useState, useEffect } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentSchedule {
  enabled:   boolean
  frequency: 'daily' | 'weekly'
  day:       number   // 0=Sun … 6=Sat
  hour:      number   // 0–23
  timezone:  string
}

interface AgentRow {
  key:          string
  lastRunAt:    string | null
  lastRunStatus:string | null
  schedule:     AgentSchedule
  nextRunAt:    string | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IMPLEMENTED = ['pak-rt', 'mas-gacor', 'intel-bakso', 'anak-intern']

const AGENT_META: Record<string, { label: string; emoji: string; role: string; defaultFreq: 'daily'|'weekly'; defaultDay: number; defaultHour: number }> = {
  'pak-rt':      { label: 'Pak RT',       emoji: '🔍', role: 'Watchdog — ranking drops',         defaultFreq: 'daily',  defaultDay: 1, defaultHour: 9 },
  'mas-gacor':   { label: 'Mas Gacor',    emoji: '📈', role: 'Trend Spotter — game trends',      defaultFreq: 'daily',  defaultDay: 1, defaultHour: 10 },
  'intel-bakso': { label: 'Intel Bakso',  emoji: '🕵️', role: 'Competitive Intel — keyword gaps', defaultFreq: 'weekly', defaultDay: 1, defaultHour: 11 },
  'anak-intern': { label: 'Anak Intern',  emoji: '✍️', role: 'Content Drafter — brief drafts',   defaultFreq: 'weekly', defaultDay: 1, defaultHour: 12 },
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const TIMEZONES = [
  { label: 'WIB (Jakarta)',   value: 'Asia/Jakarta' },
  { label: 'WITA (Makassar)', value: 'Asia/Makassar' },
  { label: 'WIT (Jayapura)',  value: 'Asia/Jayapura' },
  { label: 'UTC',             value: 'UTC' },
  { label: 'SGT (Singapore)', value: 'Asia/Singapore' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatHour(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${display}:00 ${ampm}`
}

function formatNextRun(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const diffH = Math.round(diffMs / 3600000)
  if (diffH < 1)  return 'in < 1 hour'
  if (diffH < 24) return `in ${diffH}h`
  const diffD = Math.round(diffH / 24)
  return `in ${diffD}d (${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})`
}

// ── Agent Schedule Card ───────────────────────────────────────────────────────

function AgentScheduleCard({ agentKey, initial, onSaved }: {
  agentKey: string
  initial:  AgentRow | null
  onSaved:  (key: string, nextRunAt: string | null) => void
}) {
  const meta = AGENT_META[agentKey]
  const [schedule, setSchedule] = useState<AgentSchedule>({
    enabled:   initial?.schedule.enabled   ?? false,
    frequency: initial?.schedule.frequency ?? meta.defaultFreq,
    day:       initial?.schedule.day       ?? meta.defaultDay,
    hour:      initial?.schedule.hour      ?? meta.defaultHour,
    timezone:  initial?.schedule.timezone  ?? 'Asia/Jakarta',
  })
  const [nextRunAt, setNextRunAt] = useState<string | null>(initial?.nextRunAt ?? null)
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch(`/api/agents/${agentKey}/schedule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule }),
      })
      const data = await res.json() as { ok: boolean; nextRunAt?: string }
      if (data.ok) {
        const next = data.nextRunAt ?? null
        setNextRunAt(next)
        onSaved(agentKey, next)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={`bg-gray-900 border rounded-xl overflow-hidden transition ${schedule.enabled ? 'border-blue-700/50' : 'border-gray-800'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800/60">
        <div className="flex items-center gap-3">
          <span className="text-xl">{meta.emoji}</span>
          <div>
            <h3 className="text-white font-semibold text-sm">{meta.label}</h3>
            <p className="text-gray-500 text-xs">{meta.role}</p>
          </div>
        </div>

        {/* Enable toggle */}
        <button
          onClick={() => setSchedule(s => ({ ...s, enabled: !s.enabled }))}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${schedule.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${schedule.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Schedule controls */}
      <div className={`px-5 py-4 transition ${schedule.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

          {/* Frequency */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Frequency</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {(['daily', 'weekly'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setSchedule(s => ({ ...s, frequency: f }))}
                  className={`flex-1 py-1.5 text-xs capitalize transition ${schedule.frequency === f ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {/* Day (weekly only) */}
          <div className={schedule.frequency === 'weekly' ? '' : 'opacity-30 pointer-events-none'}>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Day</label>
            <div className="flex rounded-lg overflow-hidden border border-gray-700">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  onClick={() => setSchedule(s => ({ ...s, day: i }))}
                  className={`flex-1 py-1.5 text-[10px] transition ${schedule.day === i ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Time */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5 font-medium">Time</label>
            <select
              value={schedule.hour}
              onChange={e => setSchedule(s => ({ ...s, hour: parseInt(e.target.value) }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{formatHour(h)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Timezone */}
        <div className="mt-3">
          <label className="block text-xs text-gray-400 mb-1.5 font-medium">Timezone</label>
          <select
            value={schedule.timezone}
            onChange={e => setSchedule(s => ({ ...s, timezone: e.target.value }))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
          >
            {TIMEZONES.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-5 py-3 border-t border-gray-800/60 bg-gray-950/30">
        <div className="text-xs text-gray-500">
          {schedule.enabled && nextRunAt
            ? <span>⏰ Next run: <span className="text-gray-300">{formatNextRun(nextRunAt)}</span></span>
            : schedule.enabled
            ? <span className="text-yellow-600">Not scheduled yet — save first</span>
            : <span>Schedule off</span>
          }
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition disabled:opacity-50"
        >
          {saving ? 'Saving…' : saved ? '✅ Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AgentSettingsPage() {
  const [agents,  setAgents]  = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/agents/status')
      .then(r => r.json())
      .then((data: { agents: AgentRow[] }) => setAgents(data.agents ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const agentMap = new Map(agents.map(a => [a.key, a]))

  const handleSaved = (key: string, nextRunAt: string | null) => {
    setAgents(prev => prev.map(a =>
      a.key === key ? { ...a, nextRunAt } : a
    ))
  }

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-3">
          <a href="/command-center" className="hover:text-white transition">🧠 Command Center</a>
          <span>/</span>
          <span className="text-gray-300">Agent Settings</span>
        </div>
        <h1 className="text-2xl font-bold text-white">⚙️ Agent Schedules</h1>
        <p className="text-gray-400 mt-2 text-sm">
          Set when each agent runs automatically. The scheduler checks every 15 minutes.
        </p>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading…</div>
      ) : (
        <div className="space-y-4">
          {IMPLEMENTED.map(key => (
            <AgentScheduleCard
              key={key}
              agentKey={key}
              initial={agentMap.get(key) ?? null}
              onSaved={handleSaved}
            />
          ))}
        </div>
      )}

      {/* Info box */}
      <div className="mt-8 bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
        <p className="text-xs text-gray-400 font-medium mb-2">How it works</p>
        <p className="text-xs text-gray-500 leading-relaxed">
          Vercel runs the scheduler every 15 minutes. It checks which agents are due based on their saved schedule, runs them, then sets the next run time. All runs appear in the Activity Log.
        </p>
      </div>
    </div>
  )
}
