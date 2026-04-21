import { createServiceClient } from '@/lib/supabase/service'

export interface AgentAction {
  id: string
  owner_user_id: string
  agent_key: string
  run_id: string | null
  action_type: string
  title: string
  description: string | null
  priority: string
  data: Record<string, unknown>
  site_slug: string
}

/**
 * Execute an approved agent action.
 * Returns { ok: true, handoffRunId?: string } on success.
 * handoffRunId is set when action_type === 'run_agent'.
 */
export async function executeAction(
  action: AgentAction,
  approverId: string
): Promise<{ ok: boolean; handoffRunId?: string; error?: string }> {
  const db = createServiceClient()

  try {
    if (action.action_type === 'add_action_item') {
      const data = action.data as {
        page: string
        site_url: string
        clicks_drop?: number
        position_change?: number
        action_type: string
      }

      if (!data.page || !data.site_url) {
        throw new Error('Missing page or site_url in action data')
      }

      const today = new Date().toISOString().slice(0, 10)
      const { error } = await db
        .from('seo_action_items')
        .insert({
          site_url: data.site_url,
          page: data.page,
          action_type: data.action_type,
          notes: action.description,
          snapshot_date: today,
          clicks_drop: data.clicks_drop ?? null,
          position_change: data.position_change ?? null,
          status: 'pending',
        })

      if (error) throw error
    } else if (action.action_type === 'suggest_trend_brief') {
      const data = action.data as {
        game_name: string
        [key: string]: unknown
      }

      // For trend briefs, create an action item with on_page type
      const today = new Date().toISOString().slice(0, 10)
      const categoryUrl = `https://g2g.com/categories/${data.game_name.toString().toLowerCase().replace(/\s+/g, '-')}`

      const { error } = await db
        .from('seo_action_items')
        .insert({
          site_url: 'https://g2g.com',
          page: categoryUrl,
          action_type: 'on_page',
          notes: action.description,
          snapshot_date: today,
          clicks_drop: null,
          position_change: null,
          status: 'pending',
        })

      if (error) throw error
    } else if (action.action_type === 'run_agent') {
      // Handoff: trigger another agent and create a linked run
      const data = action.data as {
        handoff_to: string
        context?: string
        payload?: Record<string, unknown>
      }

      const targetKey = data.handoff_to
      if (!targetKey) {
        throw new Error('Missing handoff_to in action data')
      }

      // Create a new agent_runs row linked to this action
      const { data: newRun, error: runErr } = await db
        .from('agent_runs')
        .insert({
          owner_user_id: action.owner_user_id,
          agent_key: targetKey,
          site_slug: action.site_slug,
          status: 'pending_implementation',
          triggered_by_action_id: action.id,
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (runErr || !newRun?.id) {
        throw new Error(`Failed to create linked run for ${targetKey}`)
      }

      // If agent is not yet implemented, mark run as completed with pending message
      const implementedAgents = ['pak-rt', 'mas-gacor', 'intel-bakso']
      if (!implementedAgents.includes(targetKey)) {
        await db
          .from('agent_runs')
          .update({
            status: 'pending_implementation',
            summary: `Agent ${targetKey} is not yet implemented`,
            finished_at: new Date().toISOString(),
          })
          .eq('id', newRun.id)
      }

      return { ok: true, handoffRunId: newRun.id }
    } else {
      throw new Error(`Unknown action_type: ${action.action_type}`)
    }

    // Mark action as executed
    const { error: updateErr } = await db
      .from('agent_actions')
      .update({
        status: 'executed',
        executed_at: new Date().toISOString(),
        approved_by: approverId,
      })
      .eq('id', action.id)

    if (updateErr) throw updateErr

    return { ok: true }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    return { ok: false, error: errorMessage }
  }
}
