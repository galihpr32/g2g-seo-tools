import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import OpportunitiesClient from './OpportunitiesClient'

export default async function OpportunitiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const effectiveOwnerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Load initial data server-side (no dismissed, sorted by recency)
  const { data: opportunities } = await db
    .from('seo_opportunities')
    .select(`
      id, topic, topic_slug, target_url, status, output_type,
      signal_count, total_sv, created_at, updated_at, last_signal_at,
      brief_id, tyr_score, tyr_status,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('owner_user_id', effectiveOwnerId)
    .neq('status', 'dismissed')
    .order('updated_at', { ascending: false })
    .limit(200)

  // Count stats for header
  const allStatuses = (opportunities ?? []).reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="p-8 max-w-7xl">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white flex items-center gap-3">
              🎯 Opportunities
            </h1>
            <p className="text-gray-400 mt-2">
              Signals from Detection agents grouped by topic. Pick an opportunity, choose an output type, and queue a brief or outreach action.
            </p>
          </div>
          <a
            href="/command-center"
            className="text-sm text-gray-500 hover:text-gray-300 transition whitespace-nowrap mt-1"
          >
            ← Command Center
          </a>
        </div>

        {/* Pipeline hint */}
        <div className="mt-4 flex items-center gap-2 text-xs text-gray-500">
          <span className="px-2 py-1 rounded bg-blue-950/40 border border-blue-800/30 text-blue-400">Detection</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-indigo-950/40 border border-indigo-800/30 text-indigo-400 font-medium">Opportunities ← you are here</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-green-950/40 border border-green-800/30 text-green-400">Brief / Outreach</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-amber-950/40 border border-amber-800/30 text-amber-400">Tyr Review</span>
          <span>→</span>
          <span className="px-2 py-1 rounded bg-purple-950/40 border border-purple-800/30 text-purple-400">Published</span>
        </div>
      </div>

      <OpportunitiesClient
        initialOpportunities={opportunities ?? []}
        statusCounts={allStatuses}
      />
    </div>
  )
}
