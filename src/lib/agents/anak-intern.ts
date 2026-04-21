import { createServiceClient } from '@/lib/supabase/service'

/**
 * Anak Intern — On-Page Content Drafter
 *
 * Triggered two ways:
 *  A) Manually (Run Now) — scans recent approved trend/gap actions with no brief yet, drafts them
 *  B) Handoff from intel-bakso — uses payload to draft a brief for a specific keyword/page
 *
 * Queues `draft_brief` actions. On approval, executor inserts into seo_content_briefs.
 */
export async function runAnakIntern(
  ownerId: string,
  siteSlug: string,
  runId: string,
  handoffPayload?: Record<string, unknown>
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const db = createServiceClient()
  const siteUrl = 'https://g2g.com'

  try {
    let actionsQueued = 0
    const findings: string[] = []

    if (handoffPayload && handoffPayload.keyword) {
      // ── Mode B: Handoff — draft brief for specific keyword/page ──────────
      const keyword   = String(handoffPayload.keyword ?? '')
      const pageUrl   = String(handoffPayload.page_url ?? `${siteUrl}/categories/${keyword.toLowerCase().replace(/\s+/g, '-')}`)
      const compUrl   = handoffPayload.competitor_url ? String(handoffPayload.competitor_url) : null
      const searchVol = Number(handoffPayload.search_volume ?? 0)
      const context   = handoffPayload.context ? String(handoffPayload.context) : null

      const priority = searchVol > 5000 ? 'high' : searchVol > 1000 ? 'medium' : 'low'
      const briefType = handoffPayload.brief_type ? String(handoffPayload.brief_type) : 'on_page'

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key:     'anak-intern',
          run_id:        runId,
          site_slug:     siteSlug,
          action_type:   'draft_brief',
          title:         `Draft brief: "${keyword}" — ${pageUrl.replace(siteUrl, '')}`,
          description:   [
            `Target keyword: ${keyword} (${searchVol.toLocaleString()} monthly searches).`,
            compUrl ? `Reference competitor: ${compUrl}.` : null,
            context ?? null,
            'Approve to auto-create the brief in Content Studio.',
          ].filter(Boolean).join(' '),
          priority,
          data: {
            page_url:          pageUrl,
            keyword,
            brief_type:        briefType,
            search_volume:     searchVol,
            competitor_url:    compUrl,
            context,
            source:            'handoff',
            triggered_run_id:  runId,
          },
        })

      if (!insertErr) {
        actionsQueued++
        findings.push(`Queued brief draft for keyword "${keyword}"`)
      }
    } else {
      // ── Mode A: Scan recent approved trend/gap actions without a brief ───
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

      // Get recently approved suggest_trend_brief and add_action_item actions
      const { data: approvedActions } = await db
        .from('agent_actions')
        .select('*')
        .eq('owner_user_id', ownerId)
        .in('action_type', ['suggest_trend_brief', 'add_action_item'])
        .eq('status', 'approved')
        .gte('approved_at', twoDaysAgo)
        .order('approved_at', { ascending: false })
        .limit(10)

      if (!approvedActions?.length) {
        const summary = 'No recently approved actions to draft briefs for.'
        await db.from('agent_runs').update({
          status: 'success', summary, findings_count: 0, actions_queued: 0, finished_at: new Date().toISOString(),
        }).eq('id', runId)
        await db.from('agents').update({
          last_run_at: new Date().toISOString(), last_run_status: 'success', last_run_summary: summary,
        }).eq('owner_user_id', ownerId).eq('agent_key', 'anak-intern')
        return { summary, actionsQueued: 0 }
      }

      for (const action of approvedActions) {
        const d = action.data as Record<string, unknown>

        // Determine keyword, page, brief_type from action
        let keyword   = ''
        let pageUrl   = ''
        let briefType = 'on_page'
        let searchVol = 0

        if (action.action_type === 'suggest_trend_brief') {
          keyword   = String(d.game_name ?? '')
          pageUrl   = `${siteUrl}/categories/${keyword.toLowerCase().replace(/\s+/g, '-')}`
          briefType = 'category_page'
          searchVol = Number(d.search_volume ?? 0)
        } else if (action.action_type === 'add_action_item') {
          keyword   = String(d.keyword ?? d.page ?? '')
          pageUrl   = String(d.page_url ?? d.site_url ?? siteUrl)
          briefType = String(d.action_type ?? 'on_page')
          searchVol = Number(d.search_volume ?? 0)
        }

        if (!keyword) continue

        // Check if brief already exists
        const { data: existingBrief } = await db
          .from('seo_content_briefs')
          .select('id')
          .eq('owner_user_id', ownerId)
          .ilike('page', `%${keyword.toLowerCase().replace(/\s+/g, '-')}%`)
          .limit(1)
          .maybeSingle()

        if (existingBrief) continue

        // Check if a draft_brief action is already queued for this keyword
        const { data: existingDraft } = await db
          .from('agent_actions')
          .select('id')
          .eq('owner_user_id', ownerId)
          .eq('action_type', 'draft_brief')
          .ilike('title', `%${keyword}%`)
          .in('status', ['pending', 'approved'])
          .limit(1)
          .maybeSingle()

        if (existingDraft) continue

        const priority = searchVol > 5000 ? 'high' : searchVol > 1000 ? 'medium' : 'low'

        const { error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'anak-intern',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'draft_brief',
            title:         `Draft brief: "${keyword}" — ${pageUrl.replace(siteUrl, '')}`,
            description:   `Based on approved "${action.action_type.replace(/_/g, ' ')}" for "${keyword}" (${searchVol.toLocaleString()} monthly searches). Approve to auto-create the content brief.`,
            priority,
            data: {
              page_url:               pageUrl,
              keyword,
              brief_type:             briefType,
              search_volume:          searchVol,
              source_action_id:       action.id,
              source_action_type:     action.action_type,
              source:                 'scan',
            },
          })

        if (!insertErr) {
          actionsQueued++
          findings.push(`Queued brief draft for "${keyword}"`)
        }
      }
    }

    const summary = actionsQueued > 0
      ? `Drafted ${actionsQueued} brief${actionsQueued !== 1 ? 's' : ''}: ${findings.slice(0, 3).join(', ')}${findings.length > 3 ? '…' : ''}`
      : 'Scanned recent approvals — no new briefs to draft.'

    await db.from('agent_runs').update({
      status: 'success',
      summary,
      findings_count: findings.length,
      actions_queued: actionsQueued,
      finished_at: new Date().toISOString(),
    }).eq('id', runId)

    await db.from('agents').update({
      last_run_at:       new Date().toISOString(),
      last_run_status:   'success',
      last_run_summary:  summary,
    }).eq('owner_user_id', ownerId).eq('agent_key', 'anak-intern')

    return { summary, actionsQueued }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    await db.from('agent_runs').update({
      status: 'error', error_message: errorMessage, finished_at: new Date().toISOString(),
    }).eq('id', runId)

    await db.from('agents').update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  'error',
      last_run_summary: errorMessage,
    }).eq('owner_user_id', ownerId).eq('agent_key', 'anak-intern')

    throw err
  }
}
