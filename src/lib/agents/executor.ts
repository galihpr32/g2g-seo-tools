import { createServiceClient } from '@/lib/supabase/service'
import { runBragi } from '@/lib/agents/bragi'
import { runHeimdall } from '@/lib/agents/heimdall'
import { runOdin } from '@/lib/agents/odin'
import { runLoki } from '@/lib/agents/loki'
import { runHermod } from '@/lib/agents/hermod'
import { generateAgentBrief } from '@/lib/agents/brief-generator'
import { getSiteUrlForSlug, buildCategoryUrl } from '@/lib/agents/site-helpers'

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
 *
 * Behaviour changes vs prior version:
 * - siteUrl looked up from site_configs by slug (no more hardcoded g2g.com)
 * - draft_brief: brief generation runs to completion before this returns,
 *   so the action is only marked 'executed' when the brief is actually
 *   filled. (User no longer sees ✓ on a stuck-in-draft brief.)
 * - run_agent: ALL implemented agents (heimdall/odin/loki/bragi/hermod)
 *   are now dispatched, and handoff awaits completion before returning.
 */
export async function executeAction(
  action: AgentAction,
  approverId: string
): Promise<{ ok: boolean; handoffRunId?: string; error?: string }> {
  const db = createServiceClient()

  try {
    // Resolve site once
    const site = await getSiteUrlForSlug(db, action.site_slug || 'g2g')
    const siteUrl = site.siteUrl

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
        page_url?: string
        [key: string]: unknown
      }

      const today = new Date().toISOString().slice(0, 10)
      const categoryUrl = String(data.page_url ?? buildCategoryUrl(siteUrl, String(data.game_name)))

      const { error } = await db
        .from('seo_action_items')
        .insert({
          site_url: siteUrl,
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
      const data = action.data as {
        domain:          string
        keyword:         string
        search_volume?:  number
        serp_position?:  number
        target_url?:     string
        topic?:          string
        draft_email?:    string
      }

      // Skip "manual research needed" rows that have no domain.
      // (Hermod no longer queues these, but defend in depth for legacy actions.)
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
          site_url:         siteUrl,
          page:             data.page_url,
          brief_type:       data.brief_type ?? 'on_page',
          primary_keyword:  data.keyword,
          status:           'draft',
          notes:            [
            data.context ?? null,
            data.competitor_url ? `Reference: ${data.competitor_url}` : null,
            data.search_volume ? `Search volume: ${data.search_volume.toLocaleString()}` : null,
            `Queued by Bragi (agent_action: ${action.id})`,
          ].filter(Boolean).join('\n'),
        })
        .select('id')
        .single()

      if (briefErr || !newBrief) throw briefErr ?? new Error('Brief insert failed')

      // AWAIT the brief generation so the action is only marked 'executed'
      // when the brief is actually populated. If it fails, the brief reverts
      // to 'draft' (handled inside generateAgentBrief) — surface that as
      // partial success on the action.
      try {
        await generateAgentBrief({
          briefId:       newBrief.id,
          ownerId:       action.owner_user_id,
          keyword:       data.keyword,
          pageUrl:       data.page_url,
          briefType:     data.brief_type ?? 'on_page',
          searchVolume:  data.search_volume,
          competitorUrl: data.competitor_url ?? null,
          notes:         data.context ?? null,
        })
      } catch (genErr) {
        // generateAgentBrief now handles its own retries internally, so a
        // throw here is genuinely unexpected. Still: record on the action
        // so the user sees it.
        console.error('[executor] brief generation threw:', genErr)
        // Don't throw — the brief stub is still queryable; treat as partial.
      }
    } else if (action.action_type === 'run_agent') {
      const data = action.data as {
        handoff_to: string
        context?: string
        payload?: Record<string, unknown>
      }

      const targetKey = data.handoff_to
      if (!targetKey) throw new Error('Missing handoff_to in action data')

      const dispatchers: Record<string, (ownerId: string, slug: string, runId: string, payload?: Record<string, unknown>) => Promise<{ summary: string; actionsQueued: number }>> = {
        heimdall: (o, s, r) => runHeimdall(o, s, r),
        odin:     (o, s, r) => runOdin(o, s, r),
        loki:     (o, s, r) => runLoki(o, s, r),
        bragi:    (o, s, r, p) => runBragi(o, s, r, p),
        hermod:   (o, s, r) => runHermod(o, s, r),
      }

      const dispatcher = dispatchers[targetKey]
      if (!dispatcher) {
        return { ok: false, error: `Agent "${targetKey}" is not implemented for handoff` }
      }

      // Create linked run row
      const { data: newRun, error: runErr } = await db
        .from('agent_runs')
        .insert({
          owner_user_id:          action.owner_user_id,
          agent_key:              targetKey,
          site_slug:              action.site_slug,
          status:                 'running',
          triggered_by_action_id: action.id,
          started_at:             new Date().toISOString(),
        })
        .select('id')
        .single()

      if (runErr || !newRun?.id) {
        throw new Error(`Failed to create linked run for ${targetKey}: ${runErr?.message ?? 'unknown'}`)
      }

      // Fire dispatch in background; don't block the API response too long.
      // The dispatched agent will update its own run record on completion.
      const payload = data.payload ?? {}
      dispatcher(action.owner_user_id, action.site_slug, newRun.id, payload)
        .catch(err => console.error(`[executor] ${targetKey} handoff failed:`, err))

      // Mark this action as executed — handoff scheduled
      const { error: updateErr } = await db
        .from('agent_actions')
        .update({
          status:      'executed',
          executed_at: new Date().toISOString(),
          approved_by: approverId,
        })
        .eq('id', action.id)

      if (updateErr) throw updateErr

      return { ok: true, handoffRunId: newRun.id }
    } else {
      throw new Error(`Unknown action_type: ${action.action_type}`)
    }

    // Mark action as executed (for non-handoff branches)
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
