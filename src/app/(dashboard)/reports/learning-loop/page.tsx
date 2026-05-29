'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// ─── Learning Loop Dashboard ────────────────────────────────────────────────
// Shows how the AI is improving from human review. Centers on three answers:
//   1. What edits are reviewers making most? (by bucket)
//   2. What KB rule proposals are pending review?
//   3. When can we enable auto-publish for which tier?

interface BucketStats { total: number; minor: number; major: number; critical: number }

interface Proposal {
  id:               string
  title:            string
  rule_text:        string
  pattern_kind:     string
  confidence:       number
  source_brief_ids: string[]
  created_at:       string
}

interface ThresholdRec {
  tier_level:           number
  current_threshold:    number
  suggested_threshold:  number | null
  approved_count:       number
  pass_pct_at_current:  number
  pass_pct_at_suggested: number | null
  sample_window_days:   number
  rationale:            string
}

interface Graduation {
  tier_level: number
  ready:      boolean
  rationale:  string
}

interface Response {
  window_days: number
  feedback_summary: {
    total_rows:   number
    unclassified: number
    by_bucket:    Record<string, BucketStats>
  }
  pending_proposals:         Proposal[]
  threshold_recommendations: ThresholdRec[]
  graduation_signals:        Graduation[]
}

export default function LearningLoopPage() {
  const [days,    setDays]    = useState<7 | 30 | 90>(30)
  const [data,    setData]    = useState<Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res  = await fetch(`/api/reports/learning-loop?days=${days}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'fetch failed')
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [days])

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">🎓 Learning Loop</h1>
          <p className="text-sm text-gray-400 mt-1">
            How human reviews train the AI for auto-publish. Tier 1 reviewers feed the model;
            non-tier auto-publish gets smarter every week.
          </p>
        </div>
        <div className="flex items-center gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800">
          {([7, 30, 90] as const).map(d => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                days === d ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-white'
              }`}
            >
              Last {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="text-center py-12 text-gray-500">Loading…</div>}
      {error   && <div className="rounded-lg border border-red-700/40 bg-red-500/5 p-4 text-sm text-red-300">⚠ {error}</div>}

      {data && (
        <>
          {/* Graduation signals — top-of-page status */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {data.graduation_signals.map(g => (
              <GraduationCard key={g.tier_level} g={g} />
            ))}
          </div>

          {/* Feedback summary */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-sm font-semibold text-white mb-3">
              📥 Review feedback this window — {data.feedback_summary.total_rows} edits captured
              {data.feedback_summary.unclassified > 0 && (
                <span className="text-[10px] text-gray-500 ml-2">({data.feedback_summary.unclassified} unclassified)</span>
              )}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {Object.entries(data.feedback_summary.by_bucket)
                .filter(([k]) => k !== 'unclassified')
                .sort((a, b) => b[1].total - a[1].total)
                .map(([bucket, stats]) => (
                  <BucketCard key={bucket} bucket={bucket} stats={stats} />
                ))}
            </div>
          </div>

          {/* Threshold recommendations */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <h2 className="text-sm font-semibold text-white mb-3">⚖ Auto-publish threshold tuning</h2>
            <div className="space-y-2">
              {data.threshold_recommendations.map(rec => (
                <ThresholdRow key={rec.tier_level} rec={rec} />
              ))}
            </div>
            <Link href="/settings/tyr-autopublish" className="inline-block mt-3 text-xs text-blue-300 hover:text-blue-200 underline">
              Adjust thresholds →
            </Link>
          </div>

          {/* Pending KB rule proposals */}
          <div className="rounded-lg border border-gray-800 bg-gray-900 p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-white">
                💡 Pending KB rule proposals — {data.pending_proposals.length}
              </h2>
              <Link href="/knowledge-base/proposals" className="text-xs text-blue-300 hover:text-blue-200 underline">
                Review all proposals →
              </Link>
            </div>
            {data.pending_proposals.length === 0 ? (
              <p className="text-xs text-gray-500">No pending proposals from review feedback yet. Aggregator runs Monday 11:00 WIB.</p>
            ) : (
              <div className="space-y-2">
                {data.pending_proposals.slice(0, 8).map(p => (
                  <ProposalRow key={p.id} p={p} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function GraduationCard({ g }: { g: Graduation }) {
  const tone = g.ready ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-gray-800 bg-gray-900'
  return (
    <div className={`rounded-lg border ${tone} p-4`}>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">
        Tier {g.tier_level === 0 ? '0 (non-tier)' : g.tier_level}
      </p>
      <p className={`text-lg font-bold mt-1 ${g.ready ? 'text-emerald-300' : 'text-gray-400'}`}>
        {g.ready ? '🟢 Ready to enable' : '🟡 Keep monitoring'}
      </p>
      <p className="text-[11px] text-gray-500 mt-1">{g.rationale}</p>
    </div>
  )
}

function BucketCard({ bucket, stats }: { bucket: string; stats: BucketStats }) {
  return (
    <div className="rounded-md border border-gray-800 bg-gray-950 p-3">
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{bucket.replace('_', ' ')}</p>
      <p className="text-lg font-bold text-white mt-0.5">{stats.total}</p>
      <p className="text-[10px] text-gray-500 mt-1">
        <span className="text-red-300">{stats.critical}c</span> · <span className="text-amber-300">{stats.major}m</span> · <span className="text-gray-400">{stats.minor}n</span>
      </p>
    </div>
  )
}

function ThresholdRow({ rec }: { rec: ThresholdRec }) {
  const tone = rec.suggested_threshold ? 'border-blue-500/30 bg-blue-500/5' : 'border-gray-800 bg-gray-950'
  return (
    <div className={`rounded-md border ${tone} p-3`}>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-white">
          Tier {rec.tier_level === 0 ? '0 (non-tier)' : rec.tier_level}
        </span>
        <span className="text-xs text-gray-400">
          Current: <b className="text-white">{rec.current_threshold}</b>
          {rec.suggested_threshold && (
            <> → Suggested: <b className="text-blue-300">{rec.suggested_threshold}</b></>
          )}
        </span>
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{rec.rationale}</p>
    </div>
  )
}

function ProposalRow({ p }: { p: Proposal }) {
  return (
    <div className="rounded-md border border-gray-800 bg-gray-950 p-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm font-medium text-white">{p.title}</span>
        <span className="text-[10px] text-gray-400">
          {p.pattern_kind} · confidence {p.confidence}/5 · from {p.source_brief_ids.length} brief(s)
        </span>
      </div>
      <p className="text-[11px] text-gray-300">{p.rule_text}</p>
    </div>
  )
}
