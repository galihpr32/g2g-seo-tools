import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import VorRecommendationsPanel from '@/components/agents/VorRecommendationsPanel'

/**
 * /command-center/tuning
 *
 * Vor agent's recommendation feed. Until now, Vor's tune_config proposals
 * lived inside the approval queue and disappeared on approval/rejection,
 * leaving zero record of what was suggested or why. This page surfaces
 * the full historical feed from agent_findings (agent_key='vor',
 * finding_type='tune_recommendation').
 *
 * Layout:
 *   - Top: live tune_config approval queue (mini)
 *   - Below: Vor recommendation history (filterable by target agent)
 *   - Sidebar: links to current agent settings + history
 */
export const revalidate = 60

export default async function TuningPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Fetch pending tune_config actions count (small banner up top)
  const { count: pendingCount } = await db
    .from('agent_actions')
    .select('id', { count: 'exact', head: true })
    .eq('owner_user_id', effectiveOwnerId)
    .eq('agent_key', 'vor')
    .eq('action_type', 'tune_config')
    .eq('status', 'pending')

  // Most recent Vor run summary (so the user knows when Vor last ran)
  const { data: lastRun } = await db
    .from('agent_runs')
    .select('started_at, finished_at, status, summary')
    .eq('owner_user_id', effectiveOwnerId)
    .eq('agent_key', 'vor')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <div className="p-8 max-w-6xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
        <a href="/command-center" className="hover:text-gray-300 transition">Command Center</a>
        <span>›</span>
        <span className="text-gray-400">Tuning</span>
      </div>

      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          🪶 Tuning — Vor&apos;s Recommendations
        </h1>
        <p className="text-gray-400 mt-2 text-sm">
          Vor watches approval/rejection patterns over the last 30 days and proposes
          adjustments to other agents&apos; thresholds. Suggestions go to the approval
          queue — nothing auto-applies.
        </p>
      </div>

      {/* Last-run summary */}
      {lastRun && (
        <div className="mb-6 bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start gap-3">
          <span className="text-xl flex-shrink-0">📡</span>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wider text-gray-500 mb-0.5">Last Vor run</p>
            <p className="text-sm text-gray-300">
              {lastRun.summary ?? '—'}
            </p>
            <p className="text-[10px] text-gray-600 mt-1">
              {lastRun.started_at && new Date(lastRun.started_at).toLocaleString('id-ID')}
              {lastRun.status && ` · ${lastRun.status}`}
            </p>
          </div>
        </div>
      )}

      {/* Pending actions */}
      {(pendingCount ?? 0) > 0 && (
        <div className="mb-6 bg-purple-900/20 border border-purple-700/30 rounded-xl px-5 py-4 flex items-center justify-between">
          <p className="text-purple-300 text-sm font-medium">
            ⚖️ {pendingCount} tune_config recommendation{(pendingCount ?? 0) !== 1 ? 's' : ''} awaiting your approval
          </p>
          <a
            href="/command-center"
            className="text-purple-300 hover:text-white text-sm underline-offset-4 hover:underline transition"
          >
            Open queue →
          </a>
        </div>
      )}

      {/* Vor recommendation history feed */}
      <VorRecommendationsPanel limit={300} />

      {/* Footer nav */}
      <div className="mt-8 pt-6 border-t border-gray-800 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <a href="/command-center"          className="text-gray-400 hover:text-white transition">← Back to Command Center</a>
        <a href="/command-center/settings"  className="text-gray-400 hover:text-white transition">⚙️ Agent settings</a>
        <a href="/command-center/insights"  className="text-gray-400 hover:text-white transition">📊 Insights</a>
        <a href="/command-center/health"    className="text-gray-400 hover:text-white transition">🩺 Health</a>
      </div>
    </div>
  )
}
