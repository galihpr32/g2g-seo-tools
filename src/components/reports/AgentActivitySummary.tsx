'use client'

/**
 * AgentActivitySummary — single unified card for both weekly + monthly reports.
 *
 * Renders the `agentInsights` blob produced by getAgentInsights(). Designed to
 * be print-friendly (no interactivity beyond hover; PDF-export pleasant).
 *
 * Hidden when there's zero agent activity in the window — keeps the report
 * clean for owners who haven't enabled agents yet.
 */

interface Highlight { title: string; detail: string; metric?: number; agent?: string }

export interface AgentInsightsLite {
  windowStart: string
  windowEnd:   string
  totals: {
    runs:           number
    runsByStatus:   Record<string, number>
    actionsQueued:  number
    actionsApproved: number
    actionsRejected: number
    actionsExecuted: number
  }
  byAgent: Array<{
    agent_key:     string
    runs:          number
    success:       number
    partial:       number
    error:         number
    actionsQueued: number
    approvalRate:  number | null
  }>
  highlights: {
    heimdallDrops:        Highlight[]
    lokiGaps:             Highlight[]
    odinTrends:           Highlight[]
    fastPathHandoffs:     number
    bragiBriefsDrafted:   number
    tyrReviewed: { total: number; promoted: number; borderline: number; failed: number; avgScore: number | null }
    sagaActivity: { clusterProposals: number; newTopics: number; archived: number; coverageReviews: number }
    vorTunings:          number
    hermodProspects:     number
  }
}

const AGENT_META: Record<string, { name: string; emoji: string; color: string }> = {
  heimdall: { name: 'Heimdall', emoji: '👁️', color: 'text-blue-400'    },
  odin:     { name: 'Odin',     emoji: '🔮', color: 'text-green-400'   },
  loki:     { name: 'Loki',     emoji: '🕵️', color: 'text-purple-400'  },
  bragi:    { name: 'Bragi',    emoji: '✍️', color: 'text-yellow-400'  },
  hermod:   { name: 'Hermod',   emoji: '🤝', color: 'text-orange-400'  },
  tyr:      { name: 'Tyr',      emoji: '⚖️', color: 'text-amber-400'   },
  vor:      { name: 'Vor',      emoji: '🦉', color: 'text-indigo-400'  },
  saga:     { name: 'Saga',     emoji: '📜', color: 'text-rose-400'    },
}

function hasActivity(insights: AgentInsightsLite | null | undefined): boolean {
  if (!insights) return false
  if (insights.totals.runs > 0) return true
  if (insights.totals.actionsApproved + insights.totals.actionsExecuted + insights.totals.actionsRejected + insights.totals.actionsQueued > 0) return true
  return false
}

export default function AgentActivitySummary({ insights }: { insights: AgentInsightsLite | null | undefined }) {
  if (!hasActivity(insights)) return null
  const i = insights as AgentInsightsLite
  const h = i.highlights

  const totalActions = i.totals.actionsQueued + i.totals.actionsApproved + i.totals.actionsExecuted + i.totals.actionsRejected

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-2xl p-6 mb-6 print:break-inside-avoid">
      <header className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-bold text-white">🤖 Agent Activity Summary</h2>
          <p className="text-gray-400 text-xs mt-0.5">
            Findings, drafts, and reviews produced by the autonomous agent layer in this period
          </p>
        </div>
        <div className="text-xs text-gray-500">
          {i.windowStart} → {i.windowEnd}
        </div>
      </header>

      {/* Top stat row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <Stat label="Runs"            value={i.totals.runs}                    color="text-white"   sub={`${i.totals.runsByStatus.success ?? 0} ok · ${i.totals.runsByStatus.partial ?? 0} partial · ${i.totals.runsByStatus.error ?? 0} err`} />
        <Stat label="Actions"         value={totalActions}                     color="text-blue-400" sub={`${i.totals.actionsQueued} pending · ${i.totals.actionsApproved + i.totals.actionsExecuted} approved`} />
        <Stat label="Briefs Drafted"  value={h.bragiBriefsDrafted}             color="text-yellow-400" sub="by Bragi" />
        <Stat label="Tyr Reviewed"    value={h.tyrReviewed.total}              color="text-amber-400"
          sub={h.tyrReviewed.avgScore !== null ? `avg ${h.tyrReviewed.avgScore}/100` : '—'} />
      </div>

      {/* Per-agent table */}
      {i.byAgent.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Per-agent breakdown</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <tr>
                  <th className="text-left  py-2 px-2">Agent</th>
                  <th className="text-right py-2 px-2">Runs</th>
                  <th className="text-right py-2 px-2">Success</th>
                  <th className="text-right py-2 px-2">Partial</th>
                  <th className="text-right py-2 px-2">Error</th>
                  <th className="text-right py-2 px-2">Actions</th>
                  <th className="text-right py-2 px-2">Approval %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {i.byAgent.map(row => {
                  const meta = AGENT_META[row.agent_key] ?? { name: row.agent_key, emoji: '🤖', color: 'text-gray-400' }
                  const rate = row.approvalRate
                  return (
                    <tr key={row.agent_key} className="hover:bg-gray-800/30">
                      <td className={`py-1.5 px-2 ${meta.color} font-medium`}>{meta.emoji} {meta.name}</td>
                      <td className="py-1.5 px-2 text-right text-gray-300">{row.runs}</td>
                      <td className="py-1.5 px-2 text-right text-green-400">{row.success}</td>
                      <td className="py-1.5 px-2 text-right text-amber-400">{row.partial || '—'}</td>
                      <td className="py-1.5 px-2 text-right text-red-400">{row.error || '—'}</td>
                      <td className="py-1.5 px-2 text-right text-gray-300">{row.actionsQueued}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${
                        rate === null ? 'text-gray-500' :
                        rate >= 0.7 ? 'text-green-400' :
                        rate >= 0.4 ? 'text-amber-400' : 'text-red-400'
                      }`}>
                        {rate === null ? '—' : `${(rate * 100).toFixed(0)}%`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top findings — 3 columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        {h.heimdallDrops.length > 0 && (
          <FindingsCard title="Top drops detected" emoji="👁️" agent="Heimdall" items={h.heimdallDrops} />
        )}
        {h.lokiGaps.length > 0 && (
          <FindingsCard title="Top competitive gaps" emoji="🕵️" agent="Loki" items={h.lokiGaps} />
        )}
        {h.odinTrends.length > 0 && (
          <FindingsCard title="Top trending opportunities" emoji="🔮" agent="Odin" items={h.odinTrends} />
        )}
      </div>

      {/* Bottom stat strip */}
      {(h.fastPathHandoffs > 0 || h.tyrReviewed.total > 0 || h.sagaActivity.clusterProposals > 0 || h.vorTunings > 0 || h.hermodProspects > 0) && (
        <div className="border-t border-gray-800 pt-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          {h.fastPathHandoffs > 0 && (
            <MiniStat label="Fast-path handoffs"    value={h.fastPathHandoffs} desc="cross-agent chains triggered" />
          )}
          {h.tyrReviewed.total > 0 && (
            <MiniStat label="Tyr quality"           value={`${h.tyrReviewed.promoted}/${h.tyrReviewed.total}`}
              desc={`auto-promoted${h.tyrReviewed.failed ? ` · ${h.tyrReviewed.failed} failed` : ''}`} />
          )}
          {h.hermodProspects > 0 && (
            <MiniStat label="Outreach prospects"    value={h.hermodProspects} desc="Hermod sourced" />
          )}
          {(h.sagaActivity.clusterProposals + h.sagaActivity.newTopics + h.sagaActivity.archived) > 0 && (
            <MiniStat label="Universe curation"     value={h.sagaActivity.clusterProposals + h.sagaActivity.newTopics + h.sagaActivity.archived}
              desc={`${h.sagaActivity.newTopics} new topics${h.sagaActivity.archived ? ` · ${h.sagaActivity.archived} archived` : ''}`} />
          )}
          {h.vorTunings > 0 && (
            <MiniStat label="Config tunings"        value={h.vorTunings} desc="Vor proposals" />
          )}
        </div>
      )}
    </section>
  )
}

function Stat({ label, value, color, sub }: { label: string; value: number | string; color?: string; sub?: string }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      <p className="text-gray-500 text-[10px] uppercase tracking-wider mt-0.5">{label}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  )
}

function MiniStat({ label, value, desc }: { label: string; value: number | string; desc?: string }) {
  return (
    <div>
      <p className="text-gray-500 text-[10px] uppercase tracking-wider">{label}</p>
      <p className="text-white text-base font-semibold mt-0.5">{value}</p>
      {desc && <p className="text-gray-600 text-[11px] mt-0.5">{desc}</p>}
    </div>
  )
}

function FindingsCard({ title, emoji, agent, items }: { title: string; emoji: string; agent: string; items: Highlight[] }) {
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
      <div className="flex items-center gap-2 mb-2">
        <span>{emoji}</span>
        <h4 className="text-xs uppercase tracking-wider text-gray-500">{title}</h4>
      </div>
      <ul className="space-y-1.5">
        {items.slice(0, 3).map((it, idx) => (
          <li key={idx} className="text-xs">
            <p className="text-white truncate" title={it.title}>{it.title}</p>
            <p className="text-gray-500 text-[11px]">{it.detail}</p>
          </li>
        ))}
      </ul>
      <p className="text-gray-600 text-[10px] mt-2 italic">via {agent}</p>
    </div>
  )
}
