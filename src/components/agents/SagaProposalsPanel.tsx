'use client'

import { useEffect, useState } from 'react'

/**
 * SagaProposalsPanel — surfaces Saga's universe-curation proposals on the
 * keyword-map page so users see "what does Saga want to change about my
 * keyword universe?" without digging into the approval queue.
 *
 * Three proposal types Saga writes findings for:
 *   • cluster_proposal  — add a keyword to existing topic OR create new topic
 *   • archive_candidate — cluster inactive 90+ days, no clicks
 *   • coverage_gap      — topic has too many unpublished clusters
 *
 * Each finding stays in agent_findings even after the underlying
 * agent_action is approved or rejected, so this panel doubles as a
 * historical log of Saga's curation work.
 */

type ProposalType = 'cluster_proposal' | 'archive_candidate' | 'coverage_gap'

interface Finding {
  id:           string
  agent_key:    string
  finding_type: string
  subject:      string | null
  severity:     'high' | 'medium' | 'low' | 'info' | null
  data:         Record<string, unknown>
  observed_at:  string
}

const TYPE_META: Record<ProposalType, { emoji: string; label: string; color: string }> = {
  cluster_proposal:  { emoji: '🧵', label: 'Cluster',     color: 'border-purple-700/40 bg-purple-900/20' },
  archive_candidate: { emoji: '📦', label: 'Archive',     color: 'border-gray-700/40 bg-gray-800/40' },
  coverage_gap:      { emoji: '🚧', label: 'Coverage gap', color: 'border-amber-700/40 bg-amber-900/20' },
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

export default function SagaProposalsPanel({ limit = 100 }: { limit?: number }) {
  const [findings, setFindings] = useState<Finding[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [tab, setTab]           = useState<'all' | ProposalType>('all')
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res = await fetch(`/api/agents/findings?agent=saga&limit=${limit}`)
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

  const proposalFindings = findings.filter(f =>
    f.finding_type === 'cluster_proposal' ||
    f.finding_type === 'archive_candidate' ||
    f.finding_type === 'coverage_gap'
  )

  const filtered = tab === 'all'
    ? proposalFindings
    : proposalFindings.filter(f => f.finding_type === tab)

  const counts = {
    cluster_proposal:  proposalFindings.filter(f => f.finding_type === 'cluster_proposal').length,
    archive_candidate: proposalFindings.filter(f => f.finding_type === 'archive_candidate').length,
    coverage_gap:      proposalFindings.filter(f => f.finding_type === 'coverage_gap').length,
  }

  if (loading) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white">📜 Saga — Recent universe proposals</h2>
        <p className="text-gray-500 text-xs mt-1">Loading…</p>
      </section>
    )
  }

  if (error) {
    return (
      <section className="bg-gray-900 border border-red-800/40 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white">📜 Saga — Recent universe proposals</h2>
        <p className="text-red-400 text-xs mt-1">Failed to load: {error}</p>
      </section>
    )
  }

  if (proposalFindings.length === 0) {
    return (
      <section className="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white mb-1">📜 Saga — Recent universe proposals</h2>
        <p className="text-gray-400 text-xs">
          Saga hasn&apos;t produced any proposals yet. Run it from Command Center.
        </p>
      </section>
    )
  }

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl mb-5">
      <header className="flex items-center justify-between p-5 pb-3 flex-wrap gap-2">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-2 text-left flex-1"
        >
          <span className="text-sm font-semibold text-white">📜 Saga — Recent universe proposals</span>
          <span className="text-gray-500 text-xs">
            ({proposalFindings.length} total · last {timeAgo(proposalFindings[0].observed_at)})
          </span>
          <span className="text-gray-600 ml-auto text-xs">{collapsed ? '▼' : '▲'}</span>
        </button>
      </header>

      {!collapsed && (
        <div className="px-5 pb-5">
          {/* Tabs */}
          <div className="flex gap-1 mb-4 border-b border-gray-800">
            {([
              ['all',                `All (${proposalFindings.length})`],
              ['cluster_proposal',   `🧵 Clusters (${counts.cluster_proposal})`],
              ['archive_candidate',  `📦 Archive (${counts.archive_candidate})`],
              ['coverage_gap',       `🚧 Coverage (${counts.coverage_gap})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key as 'all' | ProposalType)}
                className={`px-3 py-1.5 text-xs transition border-b-2 -mb-px ${
                  tab === key
                    ? 'text-white border-purple-500'
                    : 'text-gray-400 border-transparent hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* List */}
          <div className="space-y-2">
            {filtered.slice(0, 20).map(f => {
              const meta = TYPE_META[f.finding_type as ProposalType]
              if (!meta) return null
              const d = f.data as {
                cluster_name?:   string
                target_topic?:   string
                topic?:          string
                proposal_type?:  string
                reasoning?:      string
                affected_count?: number
                keywords?:       string[]
                coverage_pct?:   number
                published?:      number
                total?:          number
                search_volume?:  number
                gsc_clicks_30d?: number | null
              }
              return (
                <div key={f.id} className={`border rounded-lg p-3 ${meta.color}`}>
                  <div className="flex items-start gap-3 flex-wrap">
                    <span className="text-lg flex-shrink-0">{meta.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-0.5">
                        <span className="text-[10px] uppercase tracking-wider text-gray-500">{meta.label}</span>
                        <span className="text-white text-sm font-medium">{f.subject}</span>
                        {d.target_topic && (
                          <>
                            <span className="text-gray-600 text-xs">→</span>
                            <span className="text-purple-300 text-xs">{d.target_topic}</span>
                          </>
                        )}
                        {f.severity && (
                          <span className={`text-[9px] px-1.5 py-0.5 rounded uppercase font-medium ${
                            f.severity === 'high'   ? 'bg-red-900/40 text-red-300' :
                            f.severity === 'medium' ? 'bg-amber-900/40 text-amber-300' :
                                                      'bg-blue-900/40 text-blue-300'
                          }`}>{f.severity}</span>
                        )}
                      </div>
                      {d.reasoning && (
                        <p className="text-gray-400 text-xs leading-relaxed">{d.reasoning}</p>
                      )}
                      {/* Type-specific extras */}
                      {f.finding_type === 'cluster_proposal' && d.keywords && d.keywords.length > 1 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {d.keywords.slice(0, 8).map(k => (
                            <span key={k} className="text-[10px] bg-gray-900 border border-gray-800 px-1.5 py-0.5 rounded text-gray-300">
                              {k}
                            </span>
                          ))}
                          {d.keywords.length > 8 && (
                            <span className="text-[10px] text-gray-500">+{d.keywords.length - 8} more</span>
                          )}
                        </div>
                      )}
                      {f.finding_type === 'coverage_gap' && d.coverage_pct != null && (
                        <div className="mt-2">
                          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-amber-500 transition-all"
                              style={{ width: `${d.coverage_pct.toFixed(1)}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-gray-500 mt-0.5">
                            {d.published ?? 0} / {d.total ?? 0} clusters published ({d.coverage_pct.toFixed(0)}%)
                          </p>
                        </div>
                      )}
                      <p className="text-[10px] text-gray-600 mt-1">{timeAgo(f.observed_at)}</p>
                    </div>
                  </div>
                </div>
              )
            })}
            {filtered.length > 20 && (
              <p className="text-xs text-gray-500 text-center pt-2">
                Showing 20 of {filtered.length}. Open <a href="/command-center" className="text-blue-400 hover:underline">Command Center</a> for full queue.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
