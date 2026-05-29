'use client'

import { useEffect, useState } from 'react'

/**
 * OdinScoringPanel — surfaces Odin agent's trend-score findings on the
 * /content/trends page.
 *
 * Each Odin run scores every game it analysed (priority + composite
 * score + reasoning). Without this panel, that intelligence was buried
 * inside agent_actions for the small subset that got queued. Now the
 * full prioritised list is visible and historical.
 */

interface Finding {
  id:           string
  finding_type: string
  subject:      string | null
  severity:     'high' | 'medium' | 'low' | 'info' | null
  data:         Record<string, unknown>
  observed_at:  string
}

const PRIORITY_STYLES: Record<'high' | 'medium' | 'low', string> = {
  high:   'bg-red-900/30 text-red-300 border-red-700/40',
  medium: 'bg-amber-900/30 text-amber-300 border-amber-700/40',
  low:    'bg-blue-900/30 text-blue-300 border-blue-700/40',
}

const INTENT_STYLES: Record<string, string> = {
  informational: 'bg-sky-900/30 text-sky-300 border-sky-700/40',
  commercial:    'bg-amber-900/30 text-amber-300 border-amber-700/40',
  transactional: 'bg-green-900/30 text-green-300 border-green-700/40',
  mixed:         'bg-purple-900/30 text-purple-300 border-purple-700/40',
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

export default function OdinScoringPanel({ limit = 60 }: { limit?: number }) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/agents/findings?agent=odin&type=trend_score&limit=${limit}`)
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

  // Dedupe by game name — keep most recent score
  const dedupedByGame = Array.from(
    new Map(findings.map(f => [String(f.subject ?? '').toLowerCase(), f])).values()
  ).sort((a, b) => {
    const sA = Number((a.data as { score?: number }).score ?? 0)
    const sB = Number((b.data as { score?: number }).score ?? 0)
    return sB - sA
  })

  if (loading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white">⚡ Odin — Latest trend scoring</h2>
        <p className="text-gray-500 text-xs mt-1">Loading…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-gray-900 border border-red-800/40 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white">⚡ Odin — Latest trend scoring</h2>
        <p className="text-red-400 text-xs mt-1">Failed to load: {error}</p>
      </section>
    )
  }

  if (findings.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white mb-1">⚡ Odin — Latest trend scoring</h2>
        <p className="text-gray-400 text-xs">
          Odin hasn&apos;t scored any games yet. Run it from{' '}
          <a href="/command-center" className="text-blue-400 hover:underline">Command Center</a>.
        </p>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl mb-5">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between p-5 pb-3"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">⚡ Odin — Latest trend scoring</span>
          <span className="text-gray-500 text-xs">
            ({dedupedByGame.length} unique games · last run {timeAgo(findings[0].observed_at)})
          </span>
        </div>
        <span className="text-gray-600 text-xs">{collapsed ? '▼' : '▲'}</span>
      </button>

      {!collapsed && (
        <div className="px-5 pb-5">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-right py-2 pr-3 font-normal">Score</th>
                  <th className="text-left py-2 font-normal">Game</th>
                  <th className="text-left py-2 font-normal">Priority</th>
                  <th className="text-left py-2 font-normal">Reasoning</th>
                  <th className="text-left py-2 font-normal">Content Angle</th>
                  <th className="text-right py-2 font-normal">Players (2w)</th>
                  <th className="text-right py-2 font-normal">Search vol</th>
                  <th className="text-right py-2 font-normal">When</th>
                </tr>
              </thead>
              <tbody>
                {dedupedByGame.slice(0, 25).map(f => {
                  const d = f.data as {
                    score?:           number
                    priority?:        'high' | 'medium' | 'low'
                    reasoning?:       string
                    signals?:         { players_2weeks?: number; search_volume?: number; g2g_recommended?: boolean }
                    queued_as_brief?: boolean
                    suggested_action?: 'create_page' | 'update_page'
                    content_strategy?: {
                      intent:            string
                      content_type:      string
                      content_angle:     string
                      pillar_or_cluster: string
                    }
                  }
                  const score = Number(d.score ?? 0)
                  const prio  = d.priority ?? 'low'
                  const sig   = d.signals ?? {}
                  return (
                    <tr key={f.id} className="border-b border-gray-900 hover:bg-gray-900/40 transition">
                      <td className="py-2 pr-3 text-right">
                        <span className={`inline-block min-w-[32px] font-mono font-bold text-xs ${
                          score >= 70 ? 'text-red-400' :
                          score >= 50 ? 'text-amber-400' :
                          score >= 30 ? 'text-blue-400' : 'text-gray-500'
                        }`}>
                          {score}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-white text-xs font-medium">{f.subject}</span>
                          {sig.g2g_recommended && <span title="Listed on G2G recommended" className="text-green-400 text-[10px]">●</span>}
                          {d.queued_as_brief && <span title="Action queued for approval" className="text-purple-400 text-[10px]">●</span>}
                        </div>
                      </td>
                      <td className="py-2 pr-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase font-medium ${PRIORITY_STYLES[prio]}`}>
                          {prio}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-gray-400 text-[11px] max-w-md truncate" title={d.reasoning}>
                        {d.reasoning ?? '—'}
                      </td>
                      <td className="py-2 pr-2 max-w-xs">
                        {d.content_strategy ? (
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={`inline-block self-start text-[9px] px-1.5 py-0.5 rounded border uppercase font-semibold tracking-wide ${INTENT_STYLES[d.content_strategy.intent] ?? INTENT_STYLES.commercial}`}
                            >
                              {d.content_strategy.intent.slice(0, 4)}
                            </span>
                            <span
                              className="text-gray-400 text-[11px] leading-tight truncate"
                              title={d.content_strategy.content_angle}
                            >
                              {d.content_strategy.content_angle.length > 52
                                ? d.content_strategy.content_angle.slice(0, 52) + '…'
                                : d.content_strategy.content_angle}
                            </span>
                          </div>
                        ) : (
                          <span className="text-gray-700 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right text-gray-300 font-mono text-xs">
                        {sig.players_2weeks ? `${(sig.players_2weeks / 1000).toFixed(0)}K` : '—'}
                      </td>
                      <td className="py-2 pr-2 text-right text-gray-300 font-mono text-xs">
                        {(sig.search_volume ?? 0).toLocaleString() || '—'}
                      </td>
                      <td className="py-2 text-right text-gray-500 text-xs">
                        {timeAgo(f.observed_at)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {dedupedByGame.length > 25 && (
              <p className="text-xs text-gray-500 text-center mt-3">
                Showing 25 of {dedupedByGame.length}. Tighten the date range to refine.
              </p>
            )}
          </div>
          <p className="text-[10px] text-gray-600 mt-3">
            <span className="text-purple-400">●</span> = action queued for approval ·{' '}
            <span className="text-green-400">●</span> = currently on G2G recommended
          </p>
        </div>
      )}
    </section>
  )
}
