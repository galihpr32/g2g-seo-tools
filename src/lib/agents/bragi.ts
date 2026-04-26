import { createServiceClient } from '@/lib/supabase/service'
import { getSiteUrlForSlug, buildCategoryUrl, normalizeUrl } from '@/lib/agents/site-helpers'

/**
 * Bragi — On-Page Content Drafter
 *
 * Triggered two ways:
 *  A) Manually (Run Now) — scans recently-approved trend/gap actions with no
 *     brief yet, drafts them. Time window = since the last successful Bragi
 *     run (falls back to 14d if no prior run).
 *  B) Handoff from Loki/Heimdall — uses payload to draft a brief for a
 *     specific keyword/page.
 *
 * Queues `draft_brief` actions. On approval, executor inserts into
 * seo_content_briefs and brief-generator fills the outline asynchronously.
 */
export async function runBragi(
  ownerId: string,
  siteSlug: string,
  runId: string,
  handoffPayload?: Record<string, unknown>
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    const siteUrl = site.siteUrl

    let actionsQueued = 0
    const findings: string[] = []

    if (handoffPayload && handoffPayload.keyword) {
      // ── Mode B: Handoff — draft brief for specific keyword/page ──────────
      const keyword   = String(handoffPayload.keyword ?? '')
      const pageUrl   = String(handoffPayload.page_url ?? buildCategoryUrl(siteUrl, keyword))
      const compUrl   = handoffPayload.competitor_url ? String(handoffPayload.competitor_url) : null
      const searchVol = Number(handoffPayload.search_volume ?? 0)
      const context   = handoffPayload.context ? String(handoffPayload.context) : null
      const sourceAgent = handoffPayload.source_agent ? String(handoffPayload.source_agent) : null

      const priority  = searchVol > 5000 ? 'high' : searchVol > 1000 ? 'medium' : 'low'
      const briefType = handoffPayload.brief_type ? String(handoffPayload.brief_type) : 'on_page'

      const description = [
        `Target keyword: "${keyword}"${searchVol ? ` (${searchVol.toLocaleString()} monthly searches)` : ''}.`,
        sourceAgent ? `Source: ${sourceAgent} handoff.` : null,
        compUrl ? `Reference competitor: ${compUrl}.` : null,
        context ?? null,
        `Approve to auto-create the brief in Content Studio (Claude generates the outline).`,
      ].filter(Boolean).join(' ')

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key:     'bragi',
          run_id:        runId,
          site_slug:     siteSlug,
          action_type:   'draft_brief',
          title:         `Draft brief: "${keyword}" — ${pageUrl.replace(siteUrl, '') || '/'}`,
          description,
          priority,
          data: {
            page_url:          pageUrl,
            keyword,
            brief_type:        briefType,
            search_volume:     searchVol,
            competitor_url:    compUrl,
            context,
            source_agent:      sourceAgent,
            source:            'handoff',
            triggered_run_id:  runId,
          },
        })

      if (insertErr) {
        warnings.push(`Handoff insert failed: ${insertErr.message}`)
        console.error('[bragi] handoff insert failed:', insertErr.message)
      } else {
        actionsQueued++
        findings.push(`Queued brief draft for "${keyword}"`)
      }
    } else {
      // ── Mode A: Scan recent approved trend/gap actions without a brief ───
      // Window = since last successful Bragi run, fallback to 14d.
      const { data: bragiAgent } = await db
        .from('agents')
        .select('last_run_at')
        .eq('owner_user_id', ownerId)
        .eq('agent_key', 'bragi')
        .maybeSingle()

      const fallbackMs = 14 * 24 * 60 * 60 * 1000
      const sinceTs    = bragiAgent?.last_run_at
        ? new Date(bragiAgent.last_run_at as string).getTime()
        : (Date.now() - fallbackMs)
      const sinceIso   = new Date(sinceTs).toISOString()

      const { data: approvedActions, error: approvedErr } = await db
        .from('agent_actions')
        .select('*')
        .eq('owner_user_id', ownerId)
        .in('action_type', ['suggest_trend_brief', 'add_action_item'])
        .eq('status', 'approved')
        .gte('approved_at', sinceIso)
        .order('approved_at', { ascending: false })
        .limit(20)

      if (approvedErr) throw new Error(`agent_actions lookup failed: ${approvedErr.message}`)

      if (!approvedActions?.length) {
        const summary = `No approved actions since ${sinceIso.slice(0, 10)} to draft briefs for.`
        await _finishRun(db, runId, ownerId, 'success', summary, 0, 0, warnings)
        return { summary, actionsQueued: 0 }
      }

      for (const action of approvedActions) {
        const d = action.data as Record<string, unknown>

        let keyword   = ''
        let pageUrl   = ''
        let briefType = 'on_page'
        let searchVol = 0
        let competitorUrl: string | null = null
        let posChange:    number | null  = null

        if (action.action_type === 'suggest_trend_brief') {
          keyword   = String(d.game_name ?? '')
          pageUrl   = String(d.page_url ?? buildCategoryUrl(siteUrl, keyword))
          briefType = 'category_page'
          searchVol = Number(d.search_volume ?? 0)
        } else if (action.action_type === 'add_action_item') {
          keyword       = String(d.keyword ?? d.page ?? '')
          pageUrl       = String(d.page_url ?? d.page ?? d.site_url ?? siteUrl)
          briefType     = String(d.action_type ?? 'on_page')
          searchVol     = Number(d.search_volume ?? 0)
          competitorUrl = (d.competitor_url as string | undefined) ?? null
          posChange     = (typeof d.position_change === 'number') ? d.position_change : null
        }

        if (!keyword) continue

        const pageUrlNorm = normalizeUrl(pageUrl)

        // Check existing brief by normalized URL match (more robust than ilike on slug)
        const { data: existingBriefs } = await db
          .from('seo_content_briefs')
          .select('page')
          .eq('owner_user_id', ownerId)

        const briefExists = (existingBriefs ?? []).some(b => normalizeUrl(b.page) === pageUrlNorm)
        if (briefExists) continue

        // Existing pending/approved draft_brief for the same page?
        const { data: existingDrafts } = await db
          .from('agent_actions')
          .select('id, data')
          .eq('owner_user_id', ownerId)
          .eq('action_type', 'draft_brief')
          .in('status', ['pending', 'approved'])

        const draftExists = (existingDrafts ?? []).some(a => {
          const ad = a.data as Record<string, unknown>
          return normalizeUrl(String(ad.page_url ?? '')) === pageUrlNorm
        })
        if (draftExists) continue

        const priority = searchVol > 5000 ? 'high' : searchVol > 1000 ? 'medium' : 'low'

        const reasonBits: string[] = []
        if (action.action_type === 'suggest_trend_brief') {
          reasonBits.push(`Triggered by Odin (trending game).`)
        } else if (posChange !== null && posChange > 0) {
          reasonBits.push(`Triggered by Heimdall (page slipped ${posChange.toFixed(1)} positions).`)
        } else if (competitorUrl) {
          reasonBits.push(`Triggered by Loki (competitor ${competitorUrl} ranks for this term).`)
        } else {
          reasonBits.push(`Triggered by approved ${action.action_type.replace(/_/g, ' ')}.`)
        }

        const description = [
          `Target: "${keyword}"${searchVol ? ` (${searchVol.toLocaleString()} monthly searches)` : ''}.`,
          ...reasonBits,
          `Approve to queue auto-generation of the brief outline (Claude).`,
        ].join(' ')

        const { error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'bragi',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'draft_brief',
            title:         `Draft brief: "${keyword}" — ${pageUrl.replace(siteUrl, '') || '/'}`,
            description,
            priority,
            data: {
              page_url:               pageUrl,
              keyword,
              brief_type:             briefType,
              search_volume:          searchVol,
              competitor_url:         competitorUrl,
              source_action_id:       action.id,
              source_action_type:     action.action_type,
              source:                 'scan',
            },
          })

        if (insertErr) {
          console.error('[bragi] insert failed:', insertErr.message)
        } else {
          actionsQueued++
          findings.push(`"${keyword}"`)
        }
      }
    }

    const summary = actionsQueued > 0
      ? `Drafted ${actionsQueued} brief${actionsQueued !== 1 ? 's' : ''}: ${findings.slice(0, 3).join(', ')}${findings.length > 3 ? '…' : ''}`
      : 'Scanned recent approvals — no new briefs to draft.'
    const finalSummary = warnings.length ? `${summary} ⚠ ${warnings.join('; ')}` : summary
    const status = warnings.length ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, finalSummary, findings.length, actionsQueued, warnings)
    return { summary: finalSummary, actionsQueued }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', errorMessage, 0, 0, warnings, errorMessage)
    throw err
  }
}

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId: string,
  ownerId: string,
  status: 'success' | 'error' | 'partial',
  summary: string,
  findingsCount: number,
  actionsQueued: number,
  warnings: string[],
  errorMessage?: string
) {
  await db
    .from('agent_runs')
    .update({
      status,
      summary,
      findings_count: findingsCount,
      actions_queued: actionsQueued,
      error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
      finished_at:    new Date().toISOString(),
    })
    .eq('id', runId)

  await db
    .from('agents')
    .update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  status,
      last_run_summary: summary,
    })
    .eq('owner_user_id', ownerId)
    .eq('agent_key', 'bragi')
}
