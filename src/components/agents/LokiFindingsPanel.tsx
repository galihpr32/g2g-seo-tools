'use client'

import { useEffect, useState } from 'react'

/**
 * LokiFindingsPanel — surfaces Loki agent's competitive analysis output
 * (keyword gaps, SoV snapshots, competitor summaries) on /competitive pages.
 *
 * Data source: GET /api/agents/findings?agent=loki&type=...
 *
 * Rendering modes (controlled by `mode` prop):
 *   - 'compact'  — top widget on a hub page; shows latest SoV delta + top 5 gaps
 *   - 'keyword-gap' — sidebar/section on /competitive/keyword-gap; gap table only
 *   - 'full'     — standalone explorer (used if we ever build /competitive/insights)
 *
 * Empty states:
 *   - Loki has never run → "Loki hasn't analysed yet. Run it from Command Center."
 *   - Loki ran but no gaps → "No gaps discovered in last run. (timestamp)"
 *
 * Why this lives in /components/agents (not /components/competitive):
 * Findings come from agents and the panel is shared across /competitive
 * sub-pages (competitors hub + keyword-gap). Keeping it under agents/ makes
 * it easier to find when adding similar panels for Heimdall, Saga, Vor, etc.
 */

type Severity = 'high' | 'medium' | 'low' | 'info' | null

interface Finding {
  id:           string
  agent_key:    string
  run_id:       string | null
  finding_type: string
  subject:      string | null
  severity:     Severity
  data:         Record<string, unknown>
  observed_at:  string
}

interface Props {
  mode?: 'compact' | 'keyword-gap' | 'full'
  /**
   * Limit findings fetched. Default 100. Higher = more historical depth in UI.
   */
  limit?: number
  /**
   * Optional title override.
   */
  title?: string
}

const SEVERITY_STYLES: Record<NonNullable<Severity>, string> = {
  high:   'text-red-400 bg-red-900/30 border-red-700/40',
  medium: 'text-amber-400 bg-amber-900/30 border-amber-700/40',
  low:    'text-blue-400 bg-blue-900/30 border-blue-700/40',
  info:   'text-gray-400 bg-gray-800 border-gray-700/40',
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1)    return 'just now'
  if (m < 60)   return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)   return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7)    return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

function positionBadge(pos: number | null) {
  if (pos == null) return <span className="text-gray-600 text-xs">—</span>
  const color =
    pos <= 3  ? 'text-green-400' :
    pos <= 10 ? 'text-yellow-400' :
    pos <= 20 ? 'text-orange-400' : 'text-gray-400'
  return <span className={`text-xs font-mono font-semibold ${color}`}>#{pos}</span>
}

export default function LokiFindingsPanel({ mode = 'compact', limit = 100, title }: Props) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/agents/findings?agent=loki&limit=${limit}`)
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

  // Bucket findings by type for easy access
  const gaps     = findings.filter(f => f.finding_type === 'keyword_gap')
  const sovs     = findings.filter(f => f.finding_type === 'sov_snapshot')
  const compSums = findings.filter(f => f.finding_type === 'competitor_summary')
  const latestSov = sovs[0]
  const latestRunAt = findings[0]?.observed_at

  const headerTitle = title ?? '🦊 Loki — Latest Competitive Insights'

  if (loading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-3">{headerTitle}</h2>
        <p className="text-gray-500 text-sm">Loading findings…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-gray-900 border border-red-800/40 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-2">{headerTitle}</h2>
        <p className="text-red-400 text-sm">Failed to load findings: {error}</p>
      </section>
    )
  }

  if (findings.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-2">{headerTitle}</h2>
        <p className="text-gray-400 text-sm">
          Loki hasn&apos;t produced any findings yet. Run Loki from{' '}
          <a href="/command-center" className="text-blue-400 hover:underline">Command Center</a>{' '}
          or wait for the scheduled run.
        </p>
      </section>
    )
  }

  // Compute aggregated competitor leaderboard from latest sov snapshot.
  const sovData = latestSov?.data as {
    our_recent_sov?:         number
    our_older_sov?:          number
    sov_change?:             number
    sov_change_pct?:         number
    top_competitors_recent?: [string, number][]
    top_competitors_older?:  [string, number][]
    lost_keywords?:          string[]
    recent_window_start?:    string
  } | undefined

  const sovPct    = sovData?.sov_change_pct ?? 0
  const sovChange = sovData?.sov_change ?? 0

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
      <header className="flex items-start justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-white">{headerTitle}</h2>
          <p className="text-gray-500 text-xs mt-0.5">
            {findings.length} finding{findings.length !== 1 ? 's' : ''} loaded
            {latestRunAt && ` · last run ${timeAgo(latestRunAt)}`}
          </p>
        </div>
        <a
          href="/command-center"
          className="text-xs text-gray-400 hover:text-white transition px-2.5 py-1 rounded border border-gray-800 hover:border-gray-600"
        >
          Run Loki →
        </a>
      </header>

      {/* SoV summary card */}
      {latestSov && sovData && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-xs uppercase tracking-wider text-gray-500">📊 Share of Voice (top-10 keywords)</h3>
            <span className="text-[10px] text-gray-600">
              {sovData.recent_window_start ? `since ${sovData.recent_window_start}` : ''}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Recent (30d)</p>
              <p className="text-2xl font-bold text-white font-mono">{sovData.our_recent_sov ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Older (30-60d)</p>
              <p className="text-2xl font-bold text-gray-400 font-mono">{sovData.our_older_sov ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-0.5">Change</p>
              <p className={`text-2xl font-bold font-mono ${
                sovPct <= -10 ? 'text-red-400' :
                sovPct <  0   ? 'text-amber-400' :
                sovPct >  0   ? 'text-green-400' : 'text-gray-400'
              }`}>
                {sovChange > 0 ? '+' : ''}{sovChange}{' '}
                <span className="text-sm">({sovPct > 0 ? '+' : ''}{sovPct.toFixed(1)}%)</span>
              </p>
            </div>
          </div>
          {sovData.top_competitors_recent && sovData.top_competitors_recent.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1.5">Top competitors (current SoV)</p>
              <div className="flex flex-wrap gap-1.5">
                {sovData.top_competitors_recent.slice(0, 6).map(([domain, count]) => {
                  const olderCount = sovData.top_competitors_older?.find(([d]) => d === domain)?.[1] ?? 0
                  const delta = count - olderCount
                  return (
                    <div key={domain} className="bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs">
                      <span className="text-gray-300 font-medium">{domain}</span>
                      <span className="text-gray-500 ml-1.5">{count}</span>
                      {delta !== 0 && (
                        <span className={`ml-1 text-[10px] ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {delta > 0 ? '+' : ''}{delta}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
          {sovData.lost_keywords && sovData.lost_keywords.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800">
              <p className="text-xs text-gray-500 mb-1.5">Sample of keywords lost from top-10</p>
              <div className="flex flex-wrap gap-1.5">
                {sovData.lost_keywords.slice(0, 5).map(kw => (
                  <span key={kw} className="bg-red-950/40 border border-red-800/40 text-red-300 rounded px-2 py-0.5 text-xs">
                    {kw}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Keyword gaps table */}
      {gaps.length > 0 && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl p-4 mb-4">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">
            🎯 Recent keyword gaps
            <span className="ml-2 text-gray-600 normal-case tracking-normal">{gaps.length} total</span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 font-normal">Keyword</th>
                  <th className="text-left py-2 font-normal">Competitor</th>
                  <th className="text-right py-2 font-normal">Comp pos</th>
                  <th className="text-right py-2 font-normal">Our pos</th>
                  <th className="text-right py-2 font-normal">Volume</th>
                  <th className="text-right py-2 font-normal">When</th>
                </tr>
              </thead>
              <tbody>
                {gaps.slice(0, mode === 'compact' ? 8 : 25).map(f => {
                  const d = f.data as {
                    competitor_domain?:    string
                    competitor_position?:  number
                    our_position?:         number | null
                    search_volume?:        number
                    is_high_value?:        boolean
                    queued_as_action?:     boolean
                  }
                  return (
                    <tr key={f.id} className="border-b border-gray-900 hover:bg-gray-900/40 transition">
                      <td className="py-2 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-white">{f.subject}</span>
                          {d.is_high_value && <span title="High-value gap (≥10k SV)">⚡</span>}
                          {d.queued_as_action && <span title="Queued as approval action" className="text-purple-400 text-[10px]">●</span>}
                        </div>
                      </td>
                      <td className="py-2 pr-2 text-gray-400 text-xs">{d.competitor_domain}</td>
                      <td className="py-2 pr-2 text-right">{positionBadge(d.competitor_position ?? null)}</td>
                      <td className="py-2 pr-2 text-right">{positionBadge(d.our_position ?? null)}</td>
                      <td className="py-2 pr-2 text-right text-gray-300 font-mono text-xs">
                        {(d.search_volume ?? 0).toLocaleString()}
                      </td>
                      <td className="py-2 text-right text-gray-500 text-xs">{timeAgo(f.observed_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Competitor summaries — only in compact / full mode */}
      {mode !== 'keyword-gap' && compSums.length > 0 && (
        <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-3">🏆 Competitors analysed (latest run)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {/* dedupe — keep most recent per domain */}
            {Array.from(new Map(compSums.map(f => [f.subject ?? '', f])).values()).slice(0, 6).map(f => {
              const d = f.data as {
                domain?:               string
                total_keywords?:       number
                top10_count?:          number
                gaps_found?:           number
                sample_gap_keywords?:  string[]
              }
              return (
                <div key={f.id} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
                  <p className="text-white text-sm font-medium truncate">{d.domain}</p>
                  <div className="flex gap-3 mt-1 text-xs text-gray-400">
                    <span>{d.total_keywords ?? 0} kws</span>
                    <span className="text-yellow-400">{d.top10_count ?? 0} top-10</span>
                    <span className="text-orange-400">{d.gaps_found ?? 0} gaps</span>
                  </div>
                  <p className="text-[10px] text-gray-600 mt-1">{timeAgo(f.observed_at)}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Severity legend (compact mode only) */}
      {mode === 'compact' && (
        <p className="text-[10px] text-gray-600 mt-3">
          ⚡ = high-value gap (≥10k SV) ·{' '}
          <span className="text-purple-400">●</span> = queued for approval
        </p>
      )}
    </section>
  )
}

// Re-export severity styles for callers building their own variants
export { SEVERITY_STYLES }
