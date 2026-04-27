import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { getSiteUrlForSlug, buildCategoryUrl } from '@/lib/agents/site-helpers'
import { logClaudeUsage } from '@/lib/api-logger'
import { persistFindingsBulk } from '@/lib/agents/findings'

/**
 * Hermod — Off-Page / Outreach Agent
 *
 * Logic:
 * 1. Pre-flight: require recent (≤ 14d) Loki gap actions; otherwise warn
 *    instead of silently outputting nothing.
 * 2. Pull recently approved keyword-gap actions from Loki.
 * 3. For each gap, use the most recent SERP snapshot to identify outreach
 *    candidates ranking top-15 for the keyword.
 * 4. Cross-reference with `outreach_prospects` and pending hermod actions
 *    so we don't pitch the same domain twice.
 * 5. Use Claude to personalise the outreach pitch using domain + keyword +
 *    ranking position context. (No more boilerplate template matching.)
 * 6. Queue up to 8 draft_outreach actions per run.
 *
 * Removed: the "manual research needed" fallback — it was unactionable
 * spam in the queue. If we can't find candidates, we just skip the keyword
 * and surface that in the summary.
 */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const PITCH_MODEL = 'claude-haiku-4-5-20251001'

export async function runHermod(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{ summary: string; actionsQueued: number }> {
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    const site = await getSiteUrlForSlug(db, siteSlug)
    const ourDomain = site.domain
    const siteUrl   = site.siteUrl

    // 1. Get Loki gap actions in last 14d
    // Include BOTH normal-path 'add_action_item' AND fast-path 'run_agent'
    // — Loki's high-value gaps go straight to Bragi handoff via run_agent
    // and we want to source outreach from those too.
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const { data: gapActions } = await db
      .from('agent_actions')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('agent_key', 'loki')
      .in('action_type', ['add_action_item', 'run_agent'])
      .in('status', ['approved', 'executed'])
      .gte('created_at', fourteenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!gapActions?.length) {
      // Strict pre-flight — query agent_runs DIRECTLY (the `agents` table's
      // last_run_at field only updates if the row exists; rows are only
      // auto-created when an agent has a settings UI, so it's an unreliable
      // signal for "has Loki ever run").
      const { data: lokiRuns } = await db
        .from('agent_runs')
        .select('started_at, status')
        .eq('owner_user_id', ownerId)
        .eq('agent_key', 'loki')
        .in('status', ['success', 'partial'])
        .order('started_at', { ascending: false })
        .limit(1)

      const lokiLastRunMs = lokiRuns?.[0]?.started_at
        ? new Date(lokiRuns[0].started_at as string).getTime()
        : null
      const lokiAgeDays = lokiLastRunMs ? (Date.now() - lokiLastRunMs) / (1000 * 60 * 60 * 24) : null

      // If Loki hasn't run in >7 days, queue a run_agent action to trigger
      // Loki first. User approves it, Loki produces gaps, then Hermod can
      // run and find prospects. This breaks the "Hermod silently no-ops
      // because dependency is stale" pattern.
      if (lokiAgeDays === null || lokiAgeDays > 7) {
        const { error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'hermod',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'run_agent',
            title:         lokiAgeDays === null
              ? 'Hermod blocked: run Loki first to find keyword gaps'
              : `Hermod blocked: Loki data stale (${lokiAgeDays.toFixed(0)}d old) — refresh?`,
            description:   `Hermod needs recent Loki keyword gaps to identify outreach prospects. ${lokiAgeDays === null ? 'Loki has never run — approve to trigger first run.' : `Loki last ran ${lokiAgeDays.toFixed(0)} days ago, beyond the 7-day freshness window. Approve to re-run Loki, then Hermod will pick up the new gaps automatically next run.`}`,
            priority:      'high',
            data: {
              handoff_to: 'loki',
              context:    'hermod_dependency_refresh',
              payload:    {},
              triggered_by: 'hermod',
              hermod_run_id: runId,
            },
          })

        const summary = insertErr
          ? `No Loki gaps + failed to queue refresh (${insertErr.message})`
          : lokiAgeDays === null
            ? 'Loki has never run. Queued run_agent action to trigger Loki first — approve to proceed.'
            : `Loki data is ${lokiAgeDays.toFixed(0)}d old. Queued run_agent action to refresh Loki — approve to proceed.`
        warnings.push('loki_dependency_stale')
        await _finishRun(db, runId, ownerId, 'partial', summary, 0, insertErr ? 0 : 1, warnings)
        return { summary, actionsQueued: insertErr ? 0 : 1 }
      }

      // Loki ran recently but no approved gaps yet — likely user hasn't
      // approved any. Surface that, no automation needed.
      const summary = `Loki ran ${lokiAgeDays.toFixed(0)}d ago but no gaps have been approved yet. Approve some Loki gaps from the queue, then re-run Hermod.`
      await _finishRun(db, runId, ownerId, 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    // 2. Skip-list: ourDomain, competitors, existing prospects, pending hermod actions
    const { data: competitors } = await db
      .from('competitors')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const { data: existingProspects } = await db
      .from('outreach_prospects')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const skipDomains = new Set<string>([
      ourDomain,
      ...((competitors ?? []).map(c => String(c.domain).toLowerCase())),
      ...((existingProspects ?? []).map(p => String(p.domain).toLowerCase())),
    ])

    const { data: pendingOutreach } = await db
      .from('agent_actions')
      .select('data')
      .eq('owner_user_id', ownerId)
      .eq('action_type', 'draft_outreach')
      .eq('status', 'pending')

    for (const o of pendingOutreach ?? []) {
      const d = o.data as Record<string, unknown>
      if (d.domain) skipDomains.add(String(d.domain).toLowerCase())
    }

    let actionsQueued = 0
    const findings: string[] = []
    const processedKeywords = new Set<string>()
    const skippedNoCandidates: string[] = []

    for (const action of gapActions) {
      if (actionsQueued >= 8) break

      // Action data shape differs by Loki path:
      //  - Normal path (action_type='add_action_item'): keyword/competitor_domain at root
      //  - Fast-path     (action_type='run_agent'):     payload nested under data.payload + sharedData spread at root
      // Read with fallback to both shapes.
      const dRoot    = (action.data ?? {}) as Record<string, unknown>
      const dPayload = ((dRoot.payload ?? {}) as Record<string, unknown>)
      const d        = { ...dRoot, ...dPayload }   // payload values win where both exist (cleaner shape)

      const keyword          = String(d.keyword ?? '')
      const competitorDomain = String(d.competitor_domain ?? '').toLowerCase()
      const searchVolume     = Number(d.search_volume ?? 0)
      const targetPage       = String(d.competitor_url ? buildCategoryUrl(siteUrl, keyword) : buildCategoryUrl(siteUrl, keyword))

      if (!keyword || processedKeywords.has(keyword)) continue
      processedKeywords.add(keyword)

      // 3. Latest SERP snapshot for this keyword
      const { data: serpSnaps } = await db
        .from('serp_snapshots')
        .select('results, snapshot_date')
        .eq('owner_user_id', ownerId)
        .ilike('keyword', keyword)
        .order('snapshot_date', { ascending: false })
        .limit(1)

      type SerpResult = { domain: string; position: number; title?: string; url?: string }
      const serpRows: SerpResult[] = ((serpSnaps?.[0]?.results ?? []) as SerpResult[])
        .filter(r => r.domain && r.position <= 20)  // widened from 15 → 20 for more candidates
        .sort((a, b) => a.position - b.position)
        .slice(0, 10)

      // 4. Candidate domains
      const candidateDomains: { domain: string; position: number; title?: string; url?: string; source: 'serp' | 'loki' }[] = []
      for (const row of serpRows) {
        const dom = row.domain.toLowerCase()
        if (!skipDomains.has(dom)) {
          candidateDomains.push({ domain: dom, position: row.position, title: row.title, url: row.url, source: 'serp' })
        }
      }
      if (competitorDomain && !skipDomains.has(competitorDomain) && !candidateDomains.find(c => c.domain === competitorDomain)) {
        candidateDomains.push({
          domain:   competitorDomain,
          position: Number(d.competitor_position ?? 5),
          url:      typeof d.competitor_url === 'string' ? d.competitor_url : undefined,
          source:   'loki',
        })
      }

      if (candidateDomains.length === 0) {
        skippedNoCandidates.push(keyword)
        continue
      }

      // 4b. Persist all discovered candidates as findings — even ones we
      //     don't pitch (beyond the 8/run cap, beyond the top-2-per-keyword
      //     limit). The /outreach page surfaces these as a "discovered by
      //     Hermod" feed so users can see the full pipeline, not just
      //     queued draft emails.
      const discoveredFindings = candidateDomains.map(c => ({
        agentKey:    'hermod',
        ownerId,
        runId,
        siteSlug,
        findingType: 'prospect_discovered',
        subject:     c.domain,
        severity:    (searchVolume >= 5000 ? 'high'
                     : searchVolume >= 1000 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
        data: {
          domain:           c.domain,
          keyword,
          search_volume:    searchVolume,
          serp_position:    c.position,
          ranking_url:      c.url ?? null,
          ranking_title:    c.title ?? null,
          source:           c.source,
          source_action_id: action.id,
        },
      }))
      await persistFindingsBulk(db, discoveredFindings)

      // 5. Top 2 candidates per keyword, personalised by Claude
      for (const candidate of candidateDomains.slice(0, 2)) {
        if (actionsQueued >= 8) break
        skipDomains.add(candidate.domain)

        const angle = await buildPersonalisedAngle({
          keyword,
          domain:        candidate.domain,
          position:      candidate.position,
          rankingTitle:  candidate.title,
          rankingUrl:    candidate.url,
          targetPage,
          searchVolume,
          ourDomain,
        }, db, ownerId).catch(err => {
          warnings.push(`LLM pitch failed for ${candidate.domain}: ${err instanceof Error ? err.message : String(err)}`)
          return buildFallbackAngle(keyword, candidate.domain, targetPage, searchVolume)
        })

        const priority = searchVolume > 5000 ? 'high' : searchVolume > 1000 ? 'medium' : 'low'

        const { error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'hermod',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'draft_outreach',
            title:         `Outreach: ${candidate.domain} — ranks #${candidate.position} for "${keyword}"`,
            description:   angle.pitch,
            priority,
            data: {
              domain:           candidate.domain,
              keyword,
              search_volume:    searchVolume,
              serp_position:    candidate.position,
              ranking_url:      candidate.url ?? null,
              ranking_title:    candidate.title ?? null,
              target_url:       targetPage,
              topic:            angle.topic,
              draft_email:      angle.email,
              source:           candidate.source,
              source_action_id: action.id,
            },
          })

        if (insertErr) {
          console.error('[hermod] insert failed:', insertErr.message)
        } else {
          actionsQueued++
          findings.push(`${candidate.domain} → "${keyword}"`)
        }
      }
    }

    if (skippedNoCandidates.length > 0) {
      warnings.push(`No candidates for ${skippedNoCandidates.length} keyword(s); run a SERP snapshot job first`)
    }

    const summary = actionsQueued > 0
      ? `Found ${actionsQueued} outreach prospect${actionsQueued !== 1 ? 's' : ''} across ${processedKeywords.size} keyword gap${processedKeywords.size !== 1 ? 's' : ''}: ${findings.slice(0, 3).join(', ')}${findings.length > 3 ? '…' : ''}`
      : `Scanned ${processedKeywords.size} keyword gap${processedKeywords.size !== 1 ? 's' : ''} — no new candidates available.`

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

// ── LLM-personalised pitch ────────────────────────────────────────────────────

interface AngleInput {
  keyword:       string
  domain:        string
  position:      number
  rankingTitle?: string
  rankingUrl?:   string
  targetPage:    string
  searchVolume:  number
  ourDomain:     string
}
interface OutreachAngle { topic: string; pitch: string; email: string }

const angleTool: Anthropic.Tool = {
  name: 'submit_outreach_angle',
  description: 'Submit a personalised outreach pitch.',
  input_schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Short subject line / topic, ≤ 60 chars.' },
      pitch: { type: 'string', description: 'One-sentence summary of why this prospect is a fit (for the queue UI).' },
      email: { type: 'string', description: 'Plain-text outreach email body, 3-5 short paragraphs, NOT spammy. Reference the specific ranking title/page if provided.' },
    },
    required: ['topic', 'pitch', 'email'],
  },
}

async function buildPersonalisedAngle(
  input:    AngleInput,
  db?:      ReturnType<typeof createServiceClient>,
  ownerId?: string,
): Promise<OutreachAngle> {
  const prompt = `You are writing a B2B outreach email for G2G.com (${input.ourDomain}), a peer-to-peer gaming marketplace.

Outreach context:
- Target prospect domain: ${input.domain}
- Their ranking position: #${input.position} for the keyword "${input.keyword}" (${input.searchVolume.toLocaleString()} monthly searches)
${input.rankingTitle ? `- Specific ranking page title: "${input.rankingTitle}"` : ''}
${input.rankingUrl ? `- Specific ranking URL: ${input.rankingUrl}` : ''}
- Our target page we want them to link to: ${input.targetPage}

Write a NON-SPAMMY outreach email that:
- Opens with a specific reference to their ranking content (use the title/URL above) — NEVER generic ("I came across your site").
- States a concrete value exchange (resource link, partnership, expert quote, data) — NOT just "please link to us".
- Ends with a soft, low-pressure ask. No fake compliments. No emoji.
- 3-5 short paragraphs, plain text only.

Call the submit_outreach_angle tool.`

  const res = await anthropic.messages.create({
    model:       PITCH_MODEL,
    max_tokens:  1024,
    tools:       [angleTool],
    tool_choice: { type: 'tool', name: 'submit_outreach_angle' },
    messages:    [{ role: 'user', content: prompt }],
  })

  if (db && ownerId) {
    logClaudeUsage(db, ownerId, {
      model:       PITCH_MODEL,
      endpoint:    'outreach_pitch',
      triggeredBy: 'agent_hermod',
      usage:       res.usage,
      extra:       { domain: input.domain, keyword: input.keyword },
    })
  }

  const toolUse = res.content.find(b => b.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error(`Claude did not call submit_outreach_angle (stop=${res.stop_reason})`)
  }
  const out = toolUse.input as Record<string, unknown>
  return {
    topic: String(out.topic ?? `Outreach: ${input.keyword}`),
    pitch: String(out.pitch ?? `Pitch ${input.domain} for "${input.keyword}".`),
    email: String(out.email ?? ''),
  }
}

function buildFallbackAngle(keyword: string, domain: string, targetUrl: string, searchVolume: number): OutreachAngle {
  // Used only if Claude call fails. Generic but flagged in description so user knows.
  return {
    topic: `G2G outreach — ${keyword}`,
    pitch: `${domain} ranks for "${keyword}" (${searchVolume.toLocaleString()} searches/mo). Manually personalise before sending.`,
    email: `[NOTE: LLM personalisation unavailable — review and personalise before sending.]\n\nHi,\n\nI noticed your site ranks for "${keyword}" and wanted to reach out about a potential resource link to ${targetUrl}.\n\nHappy to discuss specifics — what works best for your audience?\n\nBest regards`,
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
  await db.from('agent_runs').update({
    status,
    summary,
    findings_count: findingsCount,
    actions_queued: actionsQueued,
    error_message:  errorMessage ?? (warnings.length ? warnings.join('; ') : null),
    finished_at:    new Date().toISOString(),
  }).eq('id', runId)

  await db.from('agents').update({
    last_run_at:      new Date().toISOString(),
    last_run_status:  status,
    last_run_summary: summary,
  }).eq('owner_user_id', ownerId).eq('agent_key', 'hermod')
}
