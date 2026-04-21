import { createServiceClient } from '@/lib/supabase/service'
import { runAnakIntern } from '@/lib/agents/anak-intern'
import { generateAgentBrief } from '@/lib/agents/brief-generator'

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
    } else if (action.action_type === 'draft_outreach') {
      // Kang Cilok: add domain to outreach tracker
      const data = action.data as {
        domain:          string
        keyword:         string
        search_volume?:  number
        serp_position?:  number
        target_url?:     string
        topic?:          string
        draft_email?:    string
      }

      // Only insert if domain is set (skip "manual research needed" suggestions without domain)
      if (data.domain) {
        const { error: outreachErr } = await db
          .from('outreach_prospects')
          .insert({
            owner_user_id:    action.owner_user_id,
            domain:           data.domain,
            source_keyword:   data.keyword,
            target_url:       data.target_url ?? null,
            topic:            data.topic ?? null,
            notes:            data.draft_email ?? null,
            status:           'prospecting',
            organic_keywords: null,
            organic_traffic:  null,
            authority_score:  null,
          })

        if (outreachErr) throw outreachErr
      }
    } else if (action.action_type === 'draft_brief') {
      // Anak Intern: create a brief stub in seo_content_briefs
      const data = action.data as {
        page_url: string
        keyword: string
        brief_type: string
        search_volume?: number
        competitor_url?: string
        context?: string
        source_action_id?: string
      }

      if (!data.page_url || !data.keyword) {
        throw new Error('Missing page_url or keyword in draft_brief data')
      }

      const { data: newBrief, error: briefErr } = await db
        .from('seo_content_briefs')
        .insert({
          owner_user_id:    action.owner_user_id,
          site_url:         'https://g2g.com',
          page:             data.page_url,
          brief_type:       data.brief_type ?? 'on_page',
          primary_keyword:  data.keyword,
          status:           'draft',
          notes:            [
            data.context ?? null,
            data.competitor_url ? `Reference: ${data.competitor_url}` : null,
            data.search_volume ? `Search volume: ${data.search_volume.toLocaleString()}` : null,
            `Queued by Anak Intern (agent_action: ${action.id})`,
          ].filter(Boolean).join('\n'),
        })
        .select('id')
        .single()

      if (briefErr || !newBrief) throw briefErr ?? new Error('Brief insert failed')

      // Fire-and-forget: auto-generate brief outline using Claude
      generateAgentBrief({
        briefId:       newBrief.id,
        ownerId:       action.owner_user_id,
        keyword:       data.keyword,
        pageUrl:       data.page_url,
        briefType:     data.brief_type ?? 'on_page',
        searchVolume:  data.search_volume,
        competitorUrl: data.competitor_url ?? null,
        notes:         data.context ?? null,
      }).catch(err => console.error('[executor] brief generation failed:', err))
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

      const implementedAgents = ['pak-rt', 'mas-gacor', 'intel-bakso', 'anak-intern', 'kang-cilok']

      // Create a new agent_runs row linked to this action
      const { data: newRun, error: runErr } = await db
        .from('agent_runs')
        .insert({
          owner_user_id: action.owner_user_id,
          agent_key: targetKey,
          site_slug: action.site_slug,
          status: implementedAgents.includes(targetKey) ? 'running' : 'pending_implementation',
          triggered_by_action_id: action.id,
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single()

      if (runErr || !newRun?.id) {
        throw new Error(`Failed to create linked run for ${targetKey}`)
      }

      // Actually run the agent if implemented
      if (targetKey === 'anak-intern') {
        const payload = data.payload ?? {}
        runAnakIntern(action.owner_user_id, action.site_slug, newRun.id, payload)
          .catch(err => console.error('[executor] anak-intern handoff failed:', err))
      } else if (!implementedAgents.includes(targetKey)) {
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
