'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Opp {
  id: string; topic: string; topic_slug: string | null; target_url: string | null
  status: string; output_type: string | null
  total_sv: number | null; signal_count: number | null
  created_at: string; updated_at: string
  brief_id: string | null
  approved_by: string | null; approved_at: string | null
  dismissed_by: string | null; dismissed_at: string | null
}

interface Brief {
  id: string; brief_type: string; status: string
  tyr_status: string | null; tyr_score: number | null
  claude_review_status: string | null; claude_review_score: number | null
  primary_keyword: string | null; page: string | null
  target_publish_date: string | null
  published_at: string | null; published_by: string | null
  assigned_to: string | null; assigned_at: string | null
  created_at: string; updated_at: string
}

interface Outcome {
  brief_id: string; checkpoint: number
  position_before: number | null; position_after: number | null
  clicks_before: number | null; clicks_after: number | null
  snapshot_date: string | null
}

interface Prospect {
  id: string; domain: string; source_keyword: string | null
  status: string; claimed_by: string | null; claimed_at: string | null
}

interface Cluster {
  id: string; map_id: string; keyword: string
  cluster_group: string | null; is_pillar: boolean; status: string
}

interface KeywordMap {
  id: string; topic: string; topic_slug: string; status: string; pillar_keyword: string | null
}

interface AgentRun {
  id: string; agent_key: string; status: string; summary: string | null
  started_at: string
}

interface AiSnapshot {
  week_starting: string; visibility_score: number; mention_rate: number
  avg_position: number | null; avg_sentiment: number; top_competitor: string | null
  prompt_coverage: number
}

interface Lifecycle {
  detected: boolean; aggregated: boolean; triaged: boolean
  has_brief: boolean; in_review: boolean; published: boolean
  has_outreach: boolean; has_outcomes: boolean
}

interface TopicData {
  slug: string; topic: string
  opps: Opp[]; primary_opp: Opp
  briefs: Brief[]
  outcomes: Outcome[]
  prospects: Prospect[]
  clusters: Cluster[]; maps: KeywordMap[]
  agent_runs: AgentRun[]
  ai_snapshots: AiSnapshot[]
  actor_map: Record<string, string>
  lifecycle: Lifecycle
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(iso: string | null): string {
  if (!iso) return '—'
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)    return 'just now'
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

function actorName(email: string | null | undefined): string {
  if (!email) return '—'
  return email.split('@')[0].split('.')[0].replace(/^./, c => c.toUpperCase())
}

function actorColor(email: string): string {
  const colors = ['bg-indigo-600', 'bg-purple-600', 'bg-pink-600', 'bg-rose-600', 'bg-orange-600', 'bg-teal-600', 'bg-cyan-600']
  let hash = 0
  for (const ch of email) hash = (hash * 31 + ch.charCodeAt(0)) % colors.length
  return colors[hash]
}

function actorInitials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]/)
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || (email[0]?.toUpperCase() ?? '?')
}

function ActorBadge({ email }: { email: string | null | undefined }) {
  if (!email) return <span className="text-gray-600 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[8px] font-semibold text-white ${actorColor(email)}`}>
        {actorInitials(email)}
      </span>
      <span className="text-gray-300">{actorName(email)}</span>
    </span>
  )
}

// ── Stage progress bar ────────────────────────────────────────────────────────
const STAGES = [
  { key: 'detected',    label: 'Detected',    icon: '👁️' },
  { key: 'aggregated',  label: 'Clustered',   icon: '📜' },
  { key: 'triaged',     label: 'Approved',    icon: '✓' },
  { key: 'has_brief',   label: 'Brief',       icon: '✍️' },
  { key: 'in_review',   label: 'Review',      icon: '⚖️' },
  { key: 'published',   label: 'Published',   icon: '📰' },
  { key: 'has_outreach',label: 'Outreach',    icon: '🤝' },
  { key: 'has_outcomes',label: 'Measured',    icon: '📊' },
] as const

function StageProgress({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-6">
      <p className="text-xs text-gray-500 mb-3 uppercase tracking-wider">Lifecycle</p>
      <div className="flex items-center gap-2 overflow-x-auto">
        {STAGES.map((s, i) => {
          const active = lifecycle[s.key as keyof Lifecycle]
          return (
            <div key={s.key} className="flex items-center gap-2 flex-shrink-0">
              <div className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition ${
                active
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-gray-800/50 border-gray-800 text-gray-600'
              }`}>
                <span className="text-sm">{s.icon}</span>
                <span className="text-xs font-medium">{s.label}</span>
              </div>
              {i < STAGES.length - 1 && (
                <span className={active ? 'text-emerald-500/60' : 'text-gray-700'}>→</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function TopicDetailPage() {
  const params = useParams<{ slug: string }>()
  const slug   = params?.slug ?? ''
  const [data, setData]       = useState<TopicData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    fetch(`/api/topics/${slug}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) setError(d.error)
        else setData(d)
      })
      .catch(() => setError('Failed to load'))
      .finally(() => setLoading(false))
  }, [slug])

  if (loading) {
    return <div className="p-8 text-gray-500 text-sm">Loading…</div>
  }
  if (error || !data) {
    return (
      <div className="p-8 max-w-2xl">
        <h1 className="text-xl font-bold text-white mb-2">Topic not found</h1>
        <p className="text-gray-500 text-sm">{error ?? 'No data for this topic.'}</p>
        <Link href="/command-center/pipeline" className="text-indigo-400 hover:text-indigo-300 text-sm mt-4 inline-block">
          ← Back to Pipeline Journey
        </Link>
      </div>
    )
  }

  const { topic, primary_opp, opps, briefs, outcomes, prospects, clusters, maps, agent_runs, ai_snapshots, actor_map, lifecycle } = data
  const publishedBrief = briefs.find(b => b.status === 'published')
  const latestSnapshot = ai_snapshots.length > 0 ? ai_snapshots[ai_snapshots.length - 1] : null

  return (
    <div className="p-6 max-w-5xl">
      {/* Breadcrumb */}
      <p className="text-xs text-gray-500 mb-2">
        <Link href="/command-center/pipeline" className="hover:text-gray-300">Pipeline</Link>
        <span className="mx-1.5">/</span>
        <span className="text-gray-400">{topic}</span>
      </p>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">{topic}</h1>
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <span className="text-[11px] px-2 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400">
            {primary_opp.status.replace('_', ' ')}
          </span>
          {primary_opp.total_sv != null && (
            <span className="text-xs text-gray-400">
              <span className="text-white font-semibold">{primary_opp.total_sv.toLocaleString()}</span> est. SV
            </span>
          )}
          <span className="text-xs text-gray-400">
            <span className="text-white font-semibold">{primary_opp.signal_count ?? 0}</span> signal{primary_opp.signal_count !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-gray-500">first detected {timeAgo(primary_opp.created_at)}</span>
          {primary_opp.target_url && (
            <a href={primary_opp.target_url} target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300">
              {new URL(primary_opp.target_url).pathname}
            </a>
          )}
        </div>
      </div>

      {/* Lifecycle progress */}
      <StageProgress lifecycle={lifecycle} />

      {/* ── Section: Briefs ─────────────────────────────────────── */}
      {briefs.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">✍️ Briefs ({briefs.length})</h2>
          <div className="space-y-2">
            {briefs.map(b => (
              <div key={b.id} className="flex items-center gap-3 py-2 border-b border-gray-800/50 last:border-0">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 font-mono">{b.brief_type}</span>
                <span className="text-sm text-white flex-1 min-w-0 truncate">{b.primary_keyword ?? '(untitled)'}</span>
                {b.tyr_score != null && (
                  <span className={`text-xs ${b.tyr_score >= 80 ? 'text-emerald-400' : b.tyr_score >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                    Tyr {b.tyr_score}
                  </span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  b.status === 'published'      ? 'bg-teal-500/15 text-teal-300' :
                  b.status === 'reviewed'       ? 'bg-emerald-500/15 text-emerald-300' :
                  b.status === 'agent_generated' ? 'bg-blue-500/15 text-blue-300' :
                  'bg-gray-800 text-gray-400'
                }`}>{b.status}</span>
                {b.published_by && actor_map[b.published_by] && (
                  <ActorBadge email={actor_map[b.published_by]} />
                )}
                <Link href={`/content/briefs/${b.id}`} className="text-xs text-blue-400 hover:text-blue-300">→</Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Section: Ranking impact (Vor) ─────────────────────────── */}
      {outcomes.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">📊 Ranking impact (Vor)</h2>
          <div className="space-y-2">
            {outcomes.map((o, i) => {
              const posDelta   = o.position_before != null && o.position_after != null ? o.position_before - o.position_after : null
              const clicksDelta = o.clicks_before != null && o.clicks_after != null ? o.clicks_after - o.clicks_before : null
              return (
                <div key={i} className="flex items-center gap-4 py-2 border-b border-gray-800/50 last:border-0">
                  <span className="text-xs text-gray-400 font-mono w-12">+{o.checkpoint}d</span>
                  <span className="text-xs text-gray-500">{o.snapshot_date ?? '—'}</span>
                  <div className="flex-1 flex items-center gap-3">
                    {o.position_after != null && (
                      <span className="text-xs text-gray-300">
                        position <span className="text-white font-semibold">#{o.position_after.toFixed(1)}</span>
                        {posDelta !== null && posDelta !== 0 && (
                          <span className={posDelta > 0 ? 'text-emerald-400 ml-1' : 'text-red-400 ml-1'}>
                            ({posDelta > 0 ? '+' : ''}{posDelta.toFixed(1)})
                          </span>
                        )}
                      </span>
                    )}
                    {clicksDelta !== null && (
                      <span className="text-xs text-gray-300">
                        clicks <span className="text-white font-semibold">{(o.clicks_after ?? 0).toLocaleString()}</span>
                        <span className={clicksDelta > 0 ? 'text-emerald-400 ml-1' : clicksDelta < 0 ? 'text-red-400 ml-1' : 'text-gray-500 ml-1'}>
                          ({clicksDelta > 0 ? '+' : ''}{clicksDelta})
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Section: AI Visibility (Frey) ─────────────────────────── */}
      {latestSnapshot && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">🦌 AI visibility (Frey)</h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 mb-1">Visibility score</p>
              <p className={`text-lg font-bold ${latestSnapshot.visibility_score >= 70 ? 'text-emerald-400' : latestSnapshot.visibility_score >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {latestSnapshot.visibility_score.toFixed(0)}<span className="text-xs text-gray-600">/100</span>
              </p>
            </div>
            <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 mb-1">Mention rate</p>
              <p className="text-lg font-bold text-white">{(latestSnapshot.mention_rate * 100).toFixed(0)}%</p>
            </div>
            <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 mb-1">Avg sentiment</p>
              <p className={`text-lg font-bold ${latestSnapshot.avg_sentiment >= 0.3 ? 'text-emerald-400' : latestSnapshot.avg_sentiment >= -0.1 ? 'text-gray-300' : 'text-red-400'}`}>
                {latestSnapshot.avg_sentiment > 0 ? '+' : ''}{latestSnapshot.avg_sentiment.toFixed(2)}
              </p>
            </div>
            <div className="bg-gray-800/40 border border-gray-800 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 mb-1">Top competitor</p>
              <p className="text-sm font-semibold text-amber-400 truncate">{latestSnapshot.top_competitor ?? '—'}</p>
            </div>
          </div>
          <p className="text-[11px] text-gray-500">Week of {latestSnapshot.week_starting} · {latestSnapshot.prompt_coverage} prompts coverage</p>
        </section>
      )}

      {/* ── Section: Outreach prospects ───────────────────────────── */}
      {prospects.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">🤝 Outreach prospects ({prospects.length})</h2>
          <div className="space-y-2">
            {prospects.slice(0, 10).map(p => (
              <div key={p.id} className="flex items-center gap-3 py-2 border-b border-gray-800/50 last:border-0">
                <span className="text-sm text-white flex-1 truncate">{p.domain}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  p.status === 'accepted' || p.status === 'published' ? 'bg-emerald-500/15 text-emerald-300' :
                  p.status === 'contacted' ? 'bg-blue-500/15 text-blue-300' :
                  'bg-gray-800 text-gray-400'
                }`}>{p.status}</span>
                {p.claimed_by && actor_map[p.claimed_by] && <ActorBadge email={actor_map[p.claimed_by]} />}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Section: Cluster membership ───────────────────────────── */}
      {clusters.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">📚 Clusters ({clusters.length})</h2>
          <div className="space-y-2">
            {clusters.map(c => {
              const map = maps.find(m => m.id === c.map_id)
              return (
                <div key={c.id} className="flex items-center gap-3 py-2 border-b border-gray-800/50 last:border-0">
                  <span className="text-sm text-white flex-1 truncate">{c.keyword}</span>
                  {c.is_pillar && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-700/40 text-red-300 font-semibold">PILLAR</span>}
                  {c.cluster_group && <span className="text-[10px] text-gray-500">{c.cluster_group}</span>}
                  {map && (
                    <Link href={`/content/keyword-map?tab=clusters&map=${map.id}`} className="text-xs text-purple-400 hover:text-purple-300">
                      → {map.topic}
                    </Link>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Section: Team activity ─────────────────────────────────── */}
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
        <h2 className="text-sm font-semibold text-white mb-3">👥 Team activity</h2>
        <div className="space-y-2 text-xs">
          {primary_opp.approved_by && actor_map[primary_opp.approved_by] && (
            <div className="flex items-center gap-3">
              <span className="text-gray-500 w-24">Approved by</span>
              <ActorBadge email={actor_map[primary_opp.approved_by]} />
              <span className="text-gray-600">{timeAgo(primary_opp.approved_at)}</span>
            </div>
          )}
          {publishedBrief?.published_by && actor_map[publishedBrief.published_by] && (
            <div className="flex items-center gap-3">
              <span className="text-gray-500 w-24">Published by</span>
              <ActorBadge email={actor_map[publishedBrief.published_by]} />
              <span className="text-gray-600">{timeAgo(publishedBrief.published_at)}</span>
            </div>
          )}
          {!primary_opp.approved_by && !publishedBrief?.published_by && (
            <p className="text-gray-600">No team activity yet.</p>
          )}
        </div>
      </section>

      {/* ── Section: Recent agent activity ─────────────────────────── */}
      {agent_runs.length > 0 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">🤖 Agent activity (last 30d)</h2>
          <div className="space-y-1.5">
            {agent_runs.slice(0, 8).map(r => (
              <div key={r.id} className="flex items-center gap-3 py-1 text-xs">
                <span className="text-gray-400 font-mono w-16">{r.agent_key}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  r.status === 'success' ? 'bg-emerald-500/15 text-emerald-300' :
                  r.status === 'partial' ? 'bg-amber-500/15 text-amber-300' :
                  r.status === 'error'   ? 'bg-red-500/15 text-red-300' :
                  'bg-gray-800 text-gray-400'
                }`}>{r.status}</span>
                <span className="text-gray-300 flex-1 truncate">{r.summary ?? '—'}</span>
                <span className="text-gray-600">{timeAgo(r.started_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Section: Opportunity history (if multiple) ─────────────── */}
      {opps.length > 1 && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-5">
          <h2 className="text-sm font-semibold text-white mb-3">📜 Opportunity history ({opps.length})</h2>
          <p className="text-[11px] text-gray-500 mb-2">Multiple opportunities matched this topic across time.</p>
          <div className="space-y-1.5">
            {opps.map(o => (
              <div key={o.id} className="flex items-center gap-3 py-1 text-xs">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">{o.status}</span>
                <span className="text-gray-300 flex-1 truncate">{o.topic}</span>
                <span className="text-gray-600">{timeAgo(o.updated_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
