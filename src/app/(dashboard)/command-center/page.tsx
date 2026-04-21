import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { createServiceClient } from '@/lib/supabase/service'
import ApprovalQueueWidget from '@/components/agents/ApprovalQueueWidget'
import AgentStatusPanel from '@/components/agents/AgentStatusPanel'

export default async function CommandCenterPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Fetch pending actions count
  const { count: pendingCount } = await db
    .from('agent_actions')
    .select('*', { count: 'exact', head: true })
    .eq('owner_user_id', effectiveOwnerId)
    .eq('status', 'pending')

  return (
    <div className="p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white flex items-center gap-3">
          🧠 Command Center
        </h1>
        <p className="text-gray-400 mt-2">
          Monitor and manage automated agents that discover SEO opportunities.
        </p>
      </div>

      {/* Pending actions alert */}
      {(pendingCount ?? 0) > 0 && (
        <div className="mb-6 bg-blue-900/20 border border-blue-700/30 rounded-xl px-6 py-4">
          <p className="text-blue-300 text-sm font-medium">
            {pendingCount} action{(pendingCount ?? 0) !== 1 ? 's' : ''} awaiting approval
          </p>
        </div>
      )}

      {/* Approval Queue Widget */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold text-white mb-4">Approval Queue</h2>
        <ApprovalQueueWidget userId={effectiveOwnerId} />
      </div>

      {/* Agent Status Panel */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Agent Status</h2>
          <div className="flex items-center gap-4">
            <a
              href="/command-center/settings"
              className="text-sm text-gray-400 hover:text-white transition"
            >
              ⚙️ Schedules
            </a>
            <a
              href="/command-center/logs"
              className="text-sm text-blue-400 hover:text-blue-300 transition"
            >
              📋 Activity Log →
            </a>
          </div>
        </div>
        <AgentStatusPanel userId={effectiveOwnerId} />
      </div>
    </div>
  )
}
