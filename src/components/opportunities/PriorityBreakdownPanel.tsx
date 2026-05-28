'use client'

import { useState } from 'react'
import { computeOpportunityPriority, type OpportunityPrioritySnapshot } from '@/lib/opportunity-priority'

/**
 * Inline expandable panel that shows how an opportunity's priority score
 * is computed. Drop into any row that has signal_count + total_sv +
 * last_signal_at + heimdall_signals.
 */
export default function PriorityBreakdownPanel({ opp }: { opp: OpportunityPrioritySnapshot }) {
  const [open, setOpen] = useState(false)
  const breakdown = computeOpportunityPriority(opp)

  const tone =
    breakdown.score >= 70 ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/40' :
    breakdown.score >= 40 ? 'bg-amber-900/30 text-amber-300 border-amber-700/40' :
    'bg-gray-800 text-gray-400 border-gray-700'

  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
        className={`text-[10px] px-1.5 py-0.5 rounded border ${tone} hover:opacity-90 transition`}
        title={breakdown.topReason}
      >
        score {breakdown.score}
      </button>

      {open && (
        <div
          className="absolute z-30 mt-6 ml-0 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-3 text-xs"
          onClick={e => e.stopPropagation()}
        >
          <p className="text-white font-semibold mb-1">Score {breakdown.score} / 100</p>
          <p className="text-gray-500 italic mb-3">{breakdown.topReason}</p>
          <div className="space-y-2">
            {breakdown.components.map(c => (
              <div key={c.key}>
                <div className="flex justify-between mb-0.5">
                  <span className="text-gray-300">{c.label}</span>
                  <span className="text-gray-500">{Math.round(c.score)} / {Math.round(c.weight * 100)}</span>
                </div>
                <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-purple-500"
                    style={{ width: `${(c.score / (c.weight * 100)) * 100}%` }}
                  />
                </div>
                <p className="text-gray-500 text-[10px] mt-0.5">{c.reason}</p>
              </div>
            ))}
          </div>
          <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-white text-[10px] mt-3">close</button>
        </div>
      )}
    </span>
  )
}
