'use client'

import { useEffect, useMemo, useState } from 'react'

/**
 * VorRecommendationsPanel — historical feed of Vor's tune_recommendation
 * findings, grouped by target agent + parameter. Used on
 * /command-center/tuning.
 *
 * Each finding is one parameter delta (e.g. heimdall.minClicksDrop: 5 → 8).
 * The panel:
 *   - Shows latest recommendation per (target_agent, parameter)
 *   - Lets user filter by target_agent (heimdall / loki / odin / tyr)
 *   - Shows reasoning + sample size + confidence inline
 *   - Reveals full history per parameter on click
 */

interface Finding {
  id:           string
  finding_type: string
  subject:      string | null    // "<agent>.<parameter>"
  severity:     'high' | 'medium' | 'low' | 'info' | null
  data:         Record<string, unknown>
  observed_at:  string
}

interface Rec {
  agent:           string
  parameter:       string
  current_value:   number | string
  suggested_value: number | string
  reasoning:       string
  confidence:      number
  metric_basis:    string
  headline?:       string
  observed_at:     string
  finding_id:      string
}

const AGENT_META: Record<string, { emoji: string; color: string; label: string }> = {
  heimdall: { emoji: '🛡️', label: 'Heimdall', color: 'text-blue-300 bg-blue-900/20 border-blue-800/40' },
  loki:     { emoji: '🦊', label: 'Loki',     color: 'text-orange-300 bg-orange-900/20 border-orange-800/40' },
  odin:     { emoji: '⚡', label: 'Odin',     color: 'text-yellow-300 bg-yellow-900/20 border-yellow-800/40' },
  tyr:      { emoji: '⚖️', label: 'Tyr',      color: 'text-amber-300 bg-amber-900/20 border-amber-800/40' },
  saga:     { emoji: '📜', label: 'Saga',     color: 'text-purple-300 bg-purple-900/20 border-purple-800/40' },
  hermod:   { emoji: '📨', label: 'Hermod',   color: 'text-cyan-300 bg-cyan-900/20 border-cyan-800/40' },
  bragi:    { emoji: '✍️', label: 'Bragi',    color: 'text-rose-300 bg-rose-900/20 border-rose-800/40' },
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString()
}

function formatVal(v: number | string): string {
  if (typeof v === 'number') return v % 1 === 0 ? v.toString() : v.toFixed(2)
  return String(v)
}

function deltaArrow(current: number | string, suggested: number | string): { arrow: string; color: string } {
  const c = Number(current), s = Number(suggested)
  if (Number.isNaN(c) || Number.isNaN(s) || c === s) return { arrow: '→', color: 'text-gray-400' }
  return s > c ? { arrow: '↑', color: 'text-orange-400' } : { arrow: '↓', color: 'text-blue-400' }
}

export default function VorRecommendationsPanel({ limit = 300 }: { limit?: number }) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [filterAgent, setFilterAgent] = useState<'all' | string>('all')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/agents/findings?agent=vor&type=tune_recommendation&limit=${limit}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!cancelled) setFindings(json.findings ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [limit])

  const recs: Rec[] = findings.map(f => {
    const d = f.data as {
      target_agent?:    string
      parameter?:       string
      current_value?:   number | string
      suggested_value?: number | string
      reasoning?:       string
      confidence?:      number
      metric_basis?:    string
      headline?:        string
    }
    return {
      agent:           String(d.target_agent ?? '—'),
      parameter:       String(d.parameter ?? '—'),
      current_value:   d.current_value ?? '—',
      suggested_value: d.suggested_value ?? '—',
      reasoning:       String(d.reasoning ?? ''),
      confidence:      Number(d.confidence ?? 0),
      metric_basis:    String(d.metric_basis ?? ''),
      headline:        d.headline,
      observed_at:     f.observed_at,
      finding_id:      f.id,
    }
  })

  // Group by (agent, parameter) — keep all rows but track latest per group
  const grouped = useMemo(() => {
    const map = new Map<string, Rec[]>()
    for (const r of recs) {
      const k = `${r.agent}.${r.parameter}`
      const arr = map.get(k) ?? []
      arr.push(r)
      map.set(k, arr)
    }
    return map
  }, [recs])

  const groupKeys = Array.from(grouped.keys())
    .filter(k => filterAgent === 'all' || k.startsWith(`${filterAgent}.`))
    .sort((a, b) => {
      const aLatest = grouped.get(a)![0].observed_at
      const bLatest = grouped.get(b)![0].observed_at
      return bLatest.localeCompare(aLatest)
    })

  const agentsPresent = Array.from(new Set(recs.map(r => r.agent))).sort()

  if (loading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">Recommendation history</h2>
        <p className="text-gray-500 text-sm mt-2">Loading…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-gray-900 border border-red-800/40 rounded-2xl p-6">
        <h2 className="text-lg font-semibold text-white">Recommendation history</h2>
        <p className="text-red-400 text-sm mt-2">Failed to load: {error}</p>
      </section>
    )
  }

  if (recs.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-8 text-center">
        <p className="text-3xl mb-3">🪶</p>
        <p className="text-white font-semibold mb-1">No recommendations yet</p>
        <p className="text-gray-400 text-sm">
          Vor needs at least 10 actions per agent over 30 days to make confident suggestions.
          Either Vor hasn&apos;t run, or your agent activity is still building up.
        </p>
        <a
          href="/command-center"
          className="inline-block mt-4 text-blue-400 hover:underline text-sm"
        >
          Run Vor manually from Command Center →
        </a>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Recommendation history</h2>
          <p className="text-gray-500 text-xs mt-0.5">
            {grouped.size} unique parameter{grouped.size !== 1 ? 's' : ''} ·{' '}
            {recs.length} total recommendation{recs.length !== 1 ? 's' : ''} across runs
          </p>
        </div>
        <div className="flex gap-1 bg-gray-950 border border-gray-800 rounded-lg p-1 flex-wrap">
          <button
            onClick={() => setFilterAgent('all')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition ${
              filterAgent === 'all' ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            All ({grouped.size})
          </button>
          {agentsPresent.map(a => {
            const meta = AGENT_META[a] ?? { emoji: '🤖', label: a, color: '' }
            const count = groupKeys.length === 0 ? 0 : Array.from(grouped.keys()).filter(k => k.startsWith(`${a}.`)).length
            return (
              <button
                key={a}
                onClick={() => setFilterAgent(a)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition flex items-center gap-1 ${
                  filterAgent === a ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span>{meta.emoji}</span>
                <span>{meta.label}</span>
                <span className="text-gray-600">({count})</span>
              </button>
            )
          })}
        </div>
      </header>

      <div className="space-y-2">
        {groupKeys.map(key => {
          const history = grouped.get(key)!
          const latest = history[0]
          const meta = AGENT_META[latest.agent] ?? { emoji: '🤖', label: latest.agent, color: '' }
          const delta = deltaArrow(latest.current_value, latest.suggested_value)
          const isExpanded = expandedKey === key
          return (
            <div key={key} className={`border rounded-lg ${meta.color}`}>
              <button
                onClick={() => setExpandedKey(p => p === key ? null : key)}
                className="w-full text-left p-3"
              >
                <div className="flex items-start gap-3 flex-wrap">
                  <span className="text-xl flex-shrink-0">{meta.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-white text-sm font-medium">{meta.label}</span>
                      <code className="text-xs text-gray-400 bg-black/30 px-1.5 py-0.5 rounded">
                        {latest.parameter}
                      </code>
                      <span className="text-gray-300 text-sm">
                        <code>{formatVal(latest.current_value)}</code>{' '}
                        <span className={`font-bold ${delta.color}`}>{delta.arrow}</span>{' '}
                        <code className="font-bold">{formatVal(latest.suggested_value)}</code>
                      </span>
                      <span className="text-[10px] text-gray-500 ml-auto">{timeAgo(latest.observed_at)}</span>
                      <span className="text-[10px] text-gray-600">▸ {history.length} rec{history.length > 1 ? 's' : ''}</span>
                    </div>
                    <p className="text-gray-400 text-xs leading-relaxed">{latest.reasoning}</p>
                    {latest.metric_basis && (
                      <p className="text-[10px] text-gray-600 mt-1">
                        Basis: {latest.metric_basis} · confidence{' '}
                        <span className="font-medium">{(latest.confidence * 100).toFixed(0)}%</span>
                      </p>
                    )}
                  </div>
                </div>
              </button>

              {/* History — expanded */}
              {isExpanded && history.length > 1 && (
                <div className="border-t border-gray-800/60 p-3 bg-black/20">
                  <p className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
                    Previous recommendations for this parameter ({history.length - 1})
                  </p>
                  <div className="space-y-1.5">
                    {history.slice(1).map(r => {
                      const d = deltaArrow(r.current_value, r.suggested_value)
                      return (
                        <div key={r.finding_id} className="text-xs flex items-center gap-2 flex-wrap">
                          <span className="text-gray-500 font-mono">
                            {new Date(r.observed_at).toLocaleDateString('id-ID')}
                          </span>
                          <span className="text-gray-300">
                            <code>{formatVal(r.current_value)}</code>{' '}
                            <span className={d.color}>{d.arrow}</span>{' '}
                            <code>{formatVal(r.suggested_value)}</code>
                          </span>
                          <span className="text-gray-600 truncate">— {r.reasoning}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {groupKeys.length === 0 && (
        <p className="text-center text-gray-500 text-sm py-6">
          No recommendations matching the current filter.
        </p>
      )}
    </section>
  )
}
