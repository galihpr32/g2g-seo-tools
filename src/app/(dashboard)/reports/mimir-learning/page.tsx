'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// Sprint MIMIR.LEARN — Mimir learning progress dashboard.
// Surfaces what Mimir knows, where the gaps are, and where to invest seeding.

interface ApiResponse {
  window_days: number
  totals: {
    total_memories:   number
    added_in_window:  number
    dormant_count:    number
    active_in_window: number
    utilization_pct:  number
  }
  coverage: Array<{ scope: string; site_slug: string | null; count: number }>
  knowledge_gaps: {
    top_categories: Array<{ category: string; count: number }>
    top_topics:     Array<{ topic: string; count: number; last_asked: string }>
    total_misses:   number
    unclassified:   number
  }
  recent_additions: Array<{ id: string; content: string; scope: string; site_slug: string | null; importance: number; tags: string[]; created_at: string }>
  dormant_memories: Array<{ id: string; content: string; scope: string; site_slug: string | null; importance: number; tags: string[]; updated_at: string }>
  source_distribution: Array<{ source: string; count: number }>
}

const WINDOW_OPTIONS = [7, 14, 30, 90] as const

export default function MimirLearningPage() {
  const [data,   setData]   = useState<ApiResponse | null>(null)
  const [error,  setError]  = useState<string | null>(null)
  const [window, setWindow] = useState<typeof WINDOW_OPTIONS[number]>(30)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Kick off load asynchronously so setState calls don't fire synchronously
    // within the effect body (avoids react-hooks/set-state-in-effect warning).
    queueMicrotask(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      fetch(`/api/reports/mimir-learning?window=${window}`)
        .then(r => r.json())
        .then(d => { if (!cancelled) {
          if (d.error) setError(d.error)
          else setData(d as ApiResponse)
        } })
        .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
        .finally(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true }
  }, [window])

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🧠 Mimir Learning Progress</h1>
          <p className="text-sm text-gray-400 mt-1">
            What Mimir knows, where the gaps are, and where to invest memory seeding effort.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-400">Window:</label>
          <select
            value={window}
            onChange={e => setWindow(Number(e.target.value) as typeof window)}
            className="text-xs bg-gray-900 border border-gray-700 rounded-md px-2 py-1.5 text-gray-200"
          >
            {WINDOW_OPTIONS.map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
          <Link href="/mimir-memory" className="text-sm text-gray-400 hover:text-white">→ Mimir Memory</Link>
        </div>
      </div>

      {error && <div className="rounded-md border border-red-700/40 bg-red-500/5 p-3 text-sm text-red-300">⚠ {error}</div>}
      {loading && !data && <div className="text-center py-12 text-gray-500">Loading…</div>}

      {data && (
        <>
          {/* ── Top metrics strip ─────────────────────────────────────── */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Total memories"      value={data.totals.total_memories} accent="purple" />
            <Metric label={`Added (${window}d)`} value={data.totals.added_in_window} accent="emerald" />
            <Metric label="Utilization"          value={`${data.totals.utilization_pct}%`} accent="blue" sub={`${data.totals.active_in_window} active / ${data.totals.total_memories}`} />
            <Metric label="Dormant"              value={data.totals.dormant_count} accent="amber" sub={`Not touched ${window}d`} />
          </section>

          {/* ── Knowledge gaps ─────────────────────────────────────────── */}
          <section className="rounded-lg border border-orange-700/40 bg-orange-500/5 p-5 space-y-4">
            <div className="flex items-baseline justify-between flex-wrap gap-2">
              <h2 className="text-base font-bold text-white">🔍 Knowledge gaps ({data.knowledge_gaps.total_misses} misses)</h2>
              <p className="text-[10px] text-gray-400">Topics asked but no memory matched — invest seeding here.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Category gaps */}
              <div>
                <h3 className="text-xs font-semibold text-orange-300 mb-2">Category-level (strategic)</h3>
                {data.knowledge_gaps.top_categories.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">
                    No category-tagged misses yet.
                    {data.knowledge_gaps.unclassified > 0 && ` (${data.knowledge_gaps.unclassified} unclassified — weekly classifier will tag.)`}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.knowledge_gaps.top_categories.map(c => (
                      <li key={c.category} className="text-sm text-gray-200 flex items-center justify-between">
                        <span>{c.category}</span>
                        <span className="font-mono text-orange-300">{c.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Topic gaps */}
              <div>
                <h3 className="text-xs font-semibold text-orange-300 mb-2">Topic-level (tactical)</h3>
                {data.knowledge_gaps.top_topics.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">No retrieval misses logged in this window.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {data.knowledge_gaps.top_topics.slice(0, 10).map(t => (
                      <li key={t.topic} className="text-sm text-gray-200 flex items-center justify-between gap-3">
                        <code className="text-xs text-orange-200 truncate flex-1">{t.topic}</code>
                        <span className="text-[10px] text-gray-500 flex-shrink-0">{relTime(t.last_asked)}</span>
                        <span className="font-mono text-orange-300 text-xs">{t.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {/* ── Coverage map ────────────────────────────────────────────── */}
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
            <h2 className="text-base font-bold text-white">Coverage by scope</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {data.coverage.map((c, i) => (
                <div key={i} className="rounded-md border border-gray-800 bg-gray-950/40 p-3">
                  <p className="text-[10px] text-gray-500 uppercase">{c.scope}{c.site_slug ? ` · ${c.site_slug}` : ''}</p>
                  <p className="text-xl font-bold text-white">{c.count}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── Source distribution ──────────────────────────────────── */}
          <section className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
            <h2 className="text-base font-bold text-white">Where memories come from</h2>
            <div className="space-y-1.5">
              {data.source_distribution.map(s => {
                const max = Math.max(...data.source_distribution.map(x => x.count))
                const pct = max > 0 ? Math.round((s.count / max) * 100) : 0
                return (
                  <div key={s.source} className="flex items-center gap-3">
                    <span className="text-xs text-gray-300 w-24 capitalize">{s.source}</span>
                    <div className="flex-1 h-3 bg-gray-800 rounded overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-purple-600 to-pink-500" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-mono text-gray-300 w-12 text-right">{s.count}</span>
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── Recent + dormant in a 2-column grid ────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <section className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
              <h2 className="text-base font-bold text-white">📥 Recent additions ({data.recent_additions.length})</h2>
              {data.recent_additions.length === 0 ? (
                <p className="text-sm text-gray-500 italic">No memories added in this window.</p>
              ) : (
                <ul className="space-y-2">
                  {data.recent_additions.slice(0, 10).map(m => (
                    <li key={m.id} className="border border-gray-800 rounded-md p-2 bg-gray-950/40">
                      <div className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{m.content}</div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                        <span>{m.scope}{m.site_slug ? `·${m.site_slug}` : ''}</span>
                        <span>·</span>
                        <span>{relTime(m.created_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-3">
              <h2 className="text-base font-bold text-white">💤 Dormant ({data.dormant_memories.length})</h2>
              {data.dormant_memories.length === 0 ? (
                <p className="text-sm text-gray-500 italic">All memories active in this window.</p>
              ) : (
                <ul className="space-y-2">
                  {data.dormant_memories.slice(0, 10).map(m => (
                    <li key={m.id} className="border border-gray-800 rounded-md p-2 bg-gray-950/40">
                      <div className="text-xs text-gray-300 line-clamp-2 leading-relaxed">{m.content}</div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                        <span>{m.scope}{m.site_slug ? `·${m.site_slug}` : ''}</span>
                        <span>·</span>
                        <span>last touched {relTime(m.updated_at)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  )
}

function Metric({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent: 'purple' | 'emerald' | 'blue' | 'amber' }) {
  const cls = {
    purple:  'border-purple-700/40 bg-purple-500/5',
    emerald: 'border-emerald-700/40 bg-emerald-500/5',
    blue:    'border-blue-700/40 bg-blue-500/5',
    amber:   'border-amber-700/40 bg-amber-500/5',
  }[accent]
  return (
    <div className={`rounded-lg border ${cls} p-4`}>
      <p className="text-[10px] uppercase tracking-wider text-gray-400 mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86400_000)
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
