import { createServiceClient } from '@/lib/supabase/service'

export interface AgentAction {
  id: string
  owner_user_id: string
  agent_key: string
  action_type: string
  title: string
  description: string | null
  priority: string
  data: Record<string, unknown>
  site_slug: string
}

/**
 * Execute an approved agent action.
 * Inserts the action into the appropriate table (e.g., seo_action_items).
 */
export async function executeAction(
  action: AgentAction,
  approverId: string
): Promise<{ ok: boolean; error?: string }> {
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
