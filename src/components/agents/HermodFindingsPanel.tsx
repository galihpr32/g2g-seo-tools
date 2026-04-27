'use client'

import { useEffect, useState } from 'react'

/**
 * HermodFindingsPanel — surfaces outreach candidates Hermod discovered
 * during automated runs (read from `agent_findings`, agent_key='hermod',
 * finding_type='prospect_discovered').
 *
 * The /outreach page's existing flow:
 *   - DiscoveryPanel  → manual "find candidates for keyword X" tool
 *   - TrackerTable    → approved prospects (outreach_prospects table)
 *
 * What was missing: candidates Hermod found automatically during scheduled
 * runs were invisible until the user approved a draft_outreach action.
 * This panel fills that gap — every candidate Hermod evaluates shows up
 * here, with a quick "promote to tracker" affordance.
 */

interface Finding {
  id:           string
  agent_key:    string
  run_id:       string | null
  finding_type: string
  subject:      string | null      // candidate domain
  severity:     'high' | 'medium' | 'low' | 'info' | null
  data:         Record<string, unknown>
  observed_at:  string
}

interface Props {
  /**
   * Called when user clicks "Add to tracker" on a finding row. Passed the
   * finding's data so the parent can pre-fill its existing add-prospect
   * flow with domain/keyword/etc.
   */
  onPromote?: (data: Record<string, unknown>) => void
  limit?: number
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const m = Math.floor(ms / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7)   return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

const SOURCE_META: Record<string, { emoji: string; label: string }> = {
  serp:  { emoji: '🔎', label: 'SERP top-10' },
  loki:  { emoji: '🦊', label: 'Loki gap' },
}

export default function HermodFindingsPanel({ onPromote, limit = 100 }: Props) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [filterSev, setFilterSev] = useState<'all' | 'high' | 'medium' | 'low'>('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/agents/findings?agent=hermod&type=prospect_discovered&limit=${limit}`)
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

  // Dedupe by domain — keep most recent (findings are DESC by observed_at)
  const dedupedByDomain = Array.from(
    new Map(findings.map(f => [String(f.subject ?? '').toLowerCase(), f])).values()
  )
  const filtered = filterSev === 'all'
    ? dedupedByDomain
    : dedupedByDomain.filter(f => f.severity === filterSev)

  if (loading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-2">📨 Hermod — Recently discovered prospects</h2>
        <p className="text-gray-500 text-sm">Loading…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-gray-900 border border-red-800/40 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-2">📨 Hermod — Recently discovered prospects</h2>
        <p className="text-red-400 text-sm">Failed to load: {error}</p>
      </section>
    )
  }

  if (findings.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
        <h2 className="text-lg font-semibold text-white mb-2">📨 Hermod — Recently discovered prospects</h2>
        <p className="text-gray-400 text-sm">
          Hermod hasn&apos;t produced findings yet. Run it from{' '}
          <a href="/command-center" className="text-blue-400 hover:underline">Command Center</a>{' '}
          (it depends on recent Loki gaps).
        </p>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-5">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">📨 Hermod — Recently discovered prospects</h2>
          <p className="text-gray-500 text-xs mt-0.5">
            {dedupedByDomain.length} unique domain{dedupedByDomain.length !== 1 ? 's' : ''} from {findings.length} findings ·{' '}
            last run {timeAgo(findings[0].observed_at)}
          </p>
        </div>
        <div className="flex gap-1 bg-gray-950 border border-gray-800 rounded-lg p-1">
          {(['all', 'high', 'medium', 'low'] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilterSev(s)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                filterSev === s ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 border-b border-gray-800">
              <th className="text-left py-2 font-normal">Domain</th>
              <th className="text-left py-2 font-normal">Keyword</th>
              <th className="text-right py-2 font-normal">SERP pos</th>
              <th className="text-right py-2 font-normal">Volume</th>
              <th className="text-left py-2 pl-3 font-normal">Source</th>
              <th className="text-right py-2 font-normal">When</th>
              <th className="text-right py-2 font-normal"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 30).map(f => {
              const d = f.data as {
                domain?:        string
                keyword?:       string
                search_volume?: number
                serp_position?: number
                ranking_url?:   string | null
                ranking_title?: string | null
                source?:        string
              }
              const meta = SOURCE_META[d.source ?? ''] ?? { emoji: '?', label: d.source ?? '—' }
              return (
                <tr key={f.id} className="border-b border-gray-900 hover:bg-gray-900/40 transition">
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-white text-xs font-medium">{d.domain}</span>
                      {f.severity && (
                        <span className={`text-[9px] uppercase px-1 py-0.5 rounded ${
                          f.severity === 'high'   ? 'bg-red-900/40 text-red-300' :
                          f.severity === 'medium' ? 'bg-amber-900/40 text-amber-300' :
                                                    'bg-blue-900/40 text-blue-300'
                        }`}>{f.severity}</span>
                      )}
                    </div>
                    {d.ranking_title && (
                      <p className="text-[10px] text-gray-600 truncate max-w-xs" title={d.ranking_title}>
                        {d.ranking_title}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-gray-300 text-xs">{d.keyword ?? '—'}</td>
                  <td className="py-2 pr-2 text-right">
                    <span className={`text-xs font-mono font-semibold ${
                      (d.serp_position ?? 99) <= 3  ? 'text-green-400' :
                      (d.serp_position ?? 99) <= 10 ? 'text-yellow-400' :
                                                     'text-orange-400'
                    }`}>
                      #{d.serp_position ?? '—'}
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right text-gray-300 font-mono text-xs">
                    {(d.search_volume ?? 0).toLocaleString()}
                  </td>
                  <td className="py-2 pl-3 text-xs text-gray-400">
                    <span title={meta.label}>{meta.emoji}</span> {meta.label}
                  </td>
                  <td className="py-2 text-right text-gray-500 text-xs">{timeAgo(f.observed_at)}</td>
                  <td className="py-2 pr-1 text-right">
                    {onPromote && (
                      <button
                        onClick={() => onPromote(f.data)}
                        className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-red-700 hover:text-white transition"
                        title="Add this prospect to the tracker"
                      >
                        + Track
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length > 30 && (
          <p className="text-xs text-gray-500 text-center mt-3">
            Showing 30 of {filtered.length} unique domains. Tighten the filter to refine.
          </p>
        )}
      </div>

      <p className="text-[10px] text-gray-600 mt-3">
        Hermod evaluates SERP top-10 + Loki competitor gaps every run — these are candidates,
        not yet contacted. Approved/contacted prospects live under the <span className="text-gray-400">Tracker</span> tab.
      </p>
    </section>
  )
}
