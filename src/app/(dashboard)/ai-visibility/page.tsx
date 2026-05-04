'use client'

import { useEffect, useState } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────
interface Snapshot {
  id:               string
  topic_slug:       string | null
  week_starting:    string
  visibility_score: number
  mention_rate:     number
  avg_position:     number | null
  avg_sentiment:    number
  prompt_coverage:  number
  llm_breakdown:    Record<string, { mentioned: number; total: number }>
  top_competitor:   string | null
}

interface Prompt {
  id:              string
  prompt_text:     string
  category:        string
  topic_slug:      string | null
  auto_topic_slug: string | null
  active:          boolean
}

interface Finding {
  id:              string
  prompt_id:       string
  llm_platform:    string
  brand_mentioned: boolean
  brand_position:  number | null
  sentiment:       number
  competitors:     Array<{ domain: string; position: number; mentions: number }>
  parser_notes:    string
  observed_at:     string
}

interface TrendPoint {
  week_starting:    string
  visibility_score: number
  mention_rate:     number
  avg_sentiment:    number
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function scoreColor(score: number): string {
  if (score >= 70) return 'text-emerald-400'
  if (score >= 50) return 'text-amber-400'
  return 'text-red-400'
}

function sentimentColor(s: number): string {
  if (s >= 0.3)  return 'text-emerald-400'
  if (s >= -0.1) return 'text-gray-400'
  return 'text-red-400'
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60)   return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function AiVisibilityPage() {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [prompts,   setPrompts]   = useState<Prompt[]>([])
  const [findings,  setFindings]  = useState<Finding[]>([])
  const [trend,     setTrend]     = useState<TrendPoint[]>([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState<'overview' | 'prompts' | 'findings'>('overview')

  useEffect(() => {
    fetch('/api/ai-visibility')
      .then(r => r.json())
      .then(d => {
        setSnapshots(d.snapshots ?? [])
        setPrompts(d.prompts ?? [])
        setFindings(d.findings ?? [])
        setTrend(d.trend ?? [])
      })
      .catch(() => { /* silent */ })
      .finally(() => setLoading(false))
  }, [])

  // Derived
  const overall = snapshots.find(s => s.topic_slug === null)
  const topicSnapshots = snapshots.filter(s => s.topic_slug !== null)
  const promptById = new Map(prompts.map(p => [p.id, p]))

  if (loading) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-bold text-white">🦌 AI Visibility</h1>
        <p className="text-gray-500 mt-4 animate-pulse">Loading…</p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">🦌 AI Visibility (Frey)</h1>
        <p className="text-sm text-gray-400 mt-1">
          How G2G appears in AI-generated answers (ChatGPT, Claude). Updated weekly via Frey agent.
        </p>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Visibility Score</p>
          <p className={`text-2xl font-bold ${overall ? scoreColor(overall.visibility_score) : 'text-gray-600'}`}>
            {overall ? overall.visibility_score.toFixed(0) : '—'}<span className="text-sm text-gray-600 font-normal">/100</span>
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Mention Rate</p>
          <p className="text-2xl font-bold text-white">
            {overall ? (overall.mention_rate * 100).toFixed(0) : '—'}<span className="text-sm text-gray-600 font-normal">%</span>
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Avg Position</p>
          <p className="text-2xl font-bold text-white">
            {overall?.avg_position ? `#${overall.avg_position.toFixed(1)}` : '—'}
          </p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs text-gray-500 mb-1">Sentiment</p>
          <p className={`text-2xl font-bold ${overall ? sentimentColor(overall.avg_sentiment) : 'text-gray-600'}`}>
            {overall ? (overall.avg_sentiment > 0 ? '+' : '') + overall.avg_sentiment.toFixed(2) : '—'}
          </p>
        </div>
      </div>

      {/* Trend chart (simple bar visualization) */}
      {trend.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <p className="text-sm font-semibold text-white mb-3">Trend — last {trend.length} weeks</p>
          <div className="flex items-end gap-2 h-24">
            {trend.map(p => (
              <div key={p.week_starting} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full bg-indigo-500/40 rounded-sm"
                  style={{ height: `${Math.max(4, p.visibility_score)}%` }}
                  title={`Score: ${p.visibility_score.toFixed(0)} · ${p.week_starting}`}
                />
                <span className="text-[9px] text-gray-600">{p.week_starting.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex bg-gray-900 border border-gray-800 rounded-lg p-0.5 gap-0.5 w-fit mb-4">
        {(['overview', 'prompts', 'findings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
              tab === t ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'
            }`}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
            {t === 'prompts'  && <span className="text-[10px] ml-1.5 text-gray-600">({prompts.filter(p => p.active).length})</span>}
            {t === 'findings' && <span className="text-[10px] ml-1.5 text-gray-600">({findings.length})</span>}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500 mb-2">Per-topic visibility this week</p>
          {topicSnapshots.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 border-dashed rounded-xl p-8 text-center">
              <p className="text-gray-500 text-sm">No topic-level snapshots yet. Run Frey via GH Actions to generate.</p>
            </div>
          ) : (
            topicSnapshots.map(s => (
              <div key={s.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">{s.topic_slug}</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">
                    {s.prompt_coverage} prompts · {(s.mention_rate * 100).toFixed(0)}% mention rate
                    {s.top_competitor && <span> · top competitor: <span className="text-amber-400">{s.top_competitor}</span></span>}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`text-lg font-bold ${scoreColor(s.visibility_score)}`}>{s.visibility_score.toFixed(0)}</p>
                  <p className="text-[10px] text-gray-600">/100</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'prompts' && (
        <div className="space-y-2">
          {prompts.map(p => (
            <div key={p.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  p.category === 'brand'         ? 'bg-purple-500/10 text-purple-400 border-purple-500/30' :
                  p.category === 'comparison'    ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' :
                  p.category === 'recommendation'? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' :
                  'bg-gray-800 text-gray-400 border-gray-700'
                }`}>{p.category}</span>
                {!p.active && <span className="text-[10px] text-gray-600">inactive</span>}
              </div>
              <p className="text-sm text-gray-200">{p.prompt_text}</p>
              {(p.topic_slug || p.auto_topic_slug) && (
                <p className="text-[10px] text-gray-600 mt-1">
                  Topic: {p.topic_slug ?? <span className="italic">auto: {p.auto_topic_slug}</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'findings' && (
        <div className="space-y-2">
          {findings.map(f => {
            const prompt = promptById.get(f.prompt_id)
            return (
              <div key={f.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 font-mono">{f.llm_platform}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    f.brand_mentioned ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                  }`}>
                    {f.brand_mentioned ? `mentioned${f.brand_position ? ` #${f.brand_position}` : ''}` : 'not mentioned'}
                  </span>
                  <span className={`text-[10px] ${sentimentColor(f.sentiment)}`}>
                    sentiment {f.sentiment > 0 ? '+' : ''}{f.sentiment.toFixed(2)}
                  </span>
                  <span className="text-[10px] text-gray-600 ml-auto">{timeAgo(f.observed_at)}</span>
                </div>
                <p className="text-gray-300 text-xs">{prompt?.prompt_text ?? '(prompt unknown)'}</p>
                {f.parser_notes && <p className="text-[11px] text-gray-500 mt-1 italic">{f.parser_notes}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
