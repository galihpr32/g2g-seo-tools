import Anthropic from '@anthropic-ai/sdk'
import { createServiceClient } from '@/lib/supabase/service'
import { getSiteUrlForSlug, buildCategoryUrl } from '@/lib/agents/site-helpers'
import { isSkipDomain } from '@/lib/agents/hermod-domain-eval'
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

    // 2. Skip-list: ALL own brand domains, competitors, existing prospects, pending hermod actions
    // ── Multi-brand defense: when running for G2G we still exclude
    //    offgamers.com (and vice versa), because we'd never pitch a sister
    //    site as a guestpost target. Pull every active site_config row.
    const { data: allSites } = await db
      .from('site_configs')
      .select('favicon_domain')
      .eq('is_active', true)
    const ownDomains: string[] = (allSites ?? [])
      .map(s => String(s.favicon_domain).toLowerCase())
      .filter(Boolean)
    // ourDomain (current site) MUST be in the list — fall back if site_configs query empty
    if (!ownDomains.includes(ourDomain)) ownDomains.push(ourDomain)

    const { data: competitors } = await db
      .from('competitors')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const { data: existingProspects } = await db
      .from('outreach_prospects')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const skipDomains = new Set<string>([
      ...ownDomains,
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
      // Two-layer skip: per-account `skipDomains` Set (own brands +
      // competitors + existing prospects) AND the global HERMOD_SKIP_DOMAINS
      // hardcoded list (gaming marketplaces, social walled gardens, etc.).
      // Both must pass for a domain to become a candidate. The hardcoded list
      // catches well-known competitors even when the user-managed
      // `competitors` table is empty.
      const isCandidate = (dom: string) =>
        !skipDomains.has(dom) && !isSkipDomain(dom)

      const candidateDomains: { domain: string; position: number; title?: string; url?: string; source: 'serp' | 'loki' }[] = []
      for (const row of serpRows) {
        const dom = row.domain.toLowerCase()
        if (isCandidate(dom)) {
          candidateDomains.push({ domain: dom, position: row.position, title: row.title, url: row.url, source: 'serp' })
        }
      }
      if (competitorDomain && isCandidate(competitorDomain) && !candidateDomains.find(c => c.domain === competitorDomain)) {
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

      // 5. Top 2 candidates per keyword, personalised by Claude.
      // Master pitch lookup (one per keyword, reused across both candidates).
      const masterPitch = await loadMasterPitch(db, ownerId, keyword).catch(err => {
        warnings.push(`master pitch lookup failed for "${keyword}": ${err instanceof Error ? err.message : String(err)}`)
        return null
      })
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
          masterPitch:   masterPitch ?? undefined,
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
      warnings.push(`No candidates for ${skippedNoCandidates.length} keyword(s); SERP snapshots missing`)

      // Queue an actionable item so the user can fix this with one click.
      // Previously this was a passive warning — now we surface it as a high-
      // priority action linking directly to the SERP tracker with the
      // missing keywords pre-filled. After the snapshot runs, Hermod will
      // find candidates on its next scheduled run.
      const missingPreview = skippedNoCandidates.slice(0, 5).map(k => `"${k}"`).join(', ')
      const moreSuffix     = skippedNoCandidates.length > 5 ? ` +${skippedNoCandidates.length - 5} more` : ''
      const trackerUrl     = `/competitive/serp-tracker?keywords=${encodeURIComponent(skippedNoCandidates.join(','))}`

      await db.from('agent_actions').insert({
        owner_user_id: ownerId,
        agent_key:     'hermod',
        run_id:        runId,
        site_slug:     siteSlug,
        action_type:   'add_action_item',
        title:         `Hermod blocked: SERP snapshots missing for ${skippedNoCandidates.length} keyword${skippedNoCandidates.length > 1 ? 's' : ''}`,
        description: [
          `Hermod found ${gapActions.length} Loki gap${gapActions.length !== 1 ? 's' : ''} but couldn't pitch any prospects because the SERP top-10 hasn't been snapshotted for: ${missingPreview}${moreSuffix}.`,
          `Approve this item to mark it as in-progress, then click the link below to run the snapshot. Hermod's next scheduled run (or manual trigger from Command Center) will pick up the prospects automatically.`,
          `→ Run SERP snapshot: ${trackerUrl}`,
        ].join(' '),
        priority: 'high',
        data: {
          keywords:        skippedNoCandidates,
          tracker_url:     trackerUrl,
          action_type:     'serp_snapshot_needed',
          source:          'hermod_blocked',
        },
      })
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

/**
 * Distilled "master pitch" pulled from an approved outreach brief in
 * seo_content_briefs. When present, Hermod feeds it to Claude so per-prospect
 * emails inherit consistent value-prop framing, talking points, anchor
 * variations, and objection-handling — instead of each Hermod call inventing
 * its own messaging from scratch.
 *
 * Loaded by `loadMasterPitch()` below; passed into `buildPersonalisedAngle()`.
 * Falls back to undefined when no matching outreach brief exists.
 */
interface MasterPitch {
  briefId:        string
  valueProp:      string         // 1-paragraph excerpt
  talkingPoints:  string[]       // 5-7 G2G facts
  anchorOptions:  string[]       // brand/generic/topical anchors
  objections:     { question: string; answer: string }[]   // top 3
  emailSkeleton?: string         // optional — full email template (markdown)
}

interface AngleInput {
  keyword:       string
  domain:        string
  position:      number
  rankingTitle?: string
  rankingUrl?:   string
  targetPage:    string
  searchVolume:  number
  ourDomain:     string
  masterPitch?:  MasterPitch     // optional — flows into the LLM prompt when present
}
interface OutreachAngle { topic: string; pitch: string; email: string }

/**
 * Look up an approved outreach brief whose primary_keyword matches the gap
 * keyword. Distills it into a MasterPitch so Hermod can keep all personalised
 * emails on-message with the writer-approved campaign template.
 *
 * Match strategy (ordered):
 *   1. Exact keyword match (lower-cased)
 *   2. Substring match either direction
 * Returns null if nothing usable found.
 */
async function loadMasterPitch(
  db:       ReturnType<typeof createServiceClient>,
  ownerId:  string,
  keyword:  string,
): Promise<MasterPitch | null> {
  const { data: briefs } = await db
    .from('seo_content_briefs')
    .select('id, primary_keyword, content_outline, faq_suggestions, new_keywords, final_content, status')
    .eq('owner_user_id', ownerId)
    .eq('brief_type',    'outreach')
    .in('status',        ['agent_generated', 'reviewed', 'published'])
    .order('updated_at', { ascending: false })
    .limit(20)

  if (!briefs?.length) return null

  const kwLower = keyword.toLowerCase().trim()
  const matched = briefs.find(b => {
    const pk = String(b.primary_keyword ?? '').toLowerCase().trim()
    return pk && (pk === kwLower || pk.includes(kwLower) || kwLower.includes(pk))
  })
  if (!matched) return null

  // Distill the brief's stored fields into prompt-ready strings.
  const outlineRaw = (matched.content_outline ?? []) as Array<{ heading?: string; points?: string[] }>
  const talkingPoints = outlineRaw
    .flatMap(s => s.points ?? [])
    .filter(p => typeof p === 'string')
    .slice(0, 7)

  const faqRaw = (matched.faq_suggestions ?? []) as Array<{ question?: string; suggested_answer?: string }>
  const objections = faqRaw
    .filter(o => o.question && o.suggested_answer)
    .slice(0, 3)
    .map(o => ({ question: String(o.question), answer: String(o.suggested_answer) }))

  const anchorRaw = (matched.new_keywords ?? []) as Array<{ keyword?: string }>
  const anchorOptions = anchorRaw
    .map(a => a.keyword ?? '')
    .filter(Boolean)
    .slice(0, 8)

  // Pull value-prop sentence from the content_draft header if present.
  const draft = String(matched.final_content ?? '')
  const valuePropMatch = draft.match(/\*\*Value proposition:\*\*\s*([^\n]+)/)
                      ?? draft.match(/^([^\n]+\.)/)
  const valueProp = valuePropMatch?.[1]?.trim() ?? ''

  if (!talkingPoints.length && !valueProp && !anchorOptions.length) return null

  return {
    briefId:        matched.id,
    valueProp,
    talkingPoints,
    anchorOptions,
    objections,
    emailSkeleton:  draft || undefined,
  }
}

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
  // When a master pitch is available (writer-approved outreach brief for this
  // keyword), inline its talking points + anchor list + objection scripts so
  // every Hermod email stays on-message with the campaign template. Without
  // it, Hermod falls back to the original from-scratch path.
  const masterBlock = input.masterPitch ? (() => {
    const lines: string[] = [
      '',
      '═══ MASTER PITCH (writer-approved campaign template) ═══',
      'Use this as your reference for tone, value framing, and acceptable anchor text.',
      'Do NOT copy verbatim — personalise to this specific prospect — but DO stay consistent with these key messages:',
    ]
    if (input.masterPitch.valueProp) {
      lines.push('', 'VALUE PROPOSITION:', input.masterPitch.valueProp)
    }
    if (input.masterPitch.talkingPoints.length) {
      lines.push('', 'KEY TALKING POINTS (weave 1-2 in naturally, do not list all):')
      for (const tp of input.masterPitch.talkingPoints.slice(0, 5)) lines.push(`  • ${tp}`)
    }
    if (input.masterPitch.anchorOptions.length) {
      lines.push('', 'APPROVED ANCHOR TEXT VARIATIONS (pick ONE for the link mention — vary across prospects):')
      for (const a of input.masterPitch.anchorOptions.slice(0, 6)) lines.push(`  • "${a}"`)
    }
    if (input.masterPitch.objections.length) {
      lines.push('', 'IF THE PROSPECT MIGHT OBJECT, anticipate it lightly in the email:')
      for (const o of input.masterPitch.objections.slice(0, 2)) {
        lines.push(`  • Likely concern: ${o.question}`)
        lines.push(`    Soft response: ${o.answer}`)
      }
    }
    lines.push('═══════════════════════════════════════════════════════', '')
    return lines.join('\n')
  })() : ''

  const prompt = `You are writing a B2B outreach email for G2G.com (${input.ourDomain}), a peer-to-peer gaming marketplace.

Outreach context:
- Target prospect domain: ${input.domain}
- Their ranking position: #${input.position} for the keyword "${input.keyword}" (${input.searchVolume.toLocaleString()} monthly searches)
${input.rankingTitle ? `- Specific ranking page title: "${input.rankingTitle}"` : ''}
${input.rankingUrl ? `- Specific ranking URL: ${input.rankingUrl}` : ''}
- Our target page we want them to link to: ${input.targetPage}
${masterBlock}
Write a NON-SPAMMY outreach email that:
- Opens with a specific reference to their ranking content (use the title/URL above) — NEVER generic ("I came across your site").
- States a concrete value exchange (resource link, partnership, expert quote, data) — NOT just "please link to us".
- Ends with a soft, low-pressure ask. No fake compliments. No emoji.
- 3-5 short paragraphs, plain text only.
${input.masterPitch ? '- Stay on-message with the master pitch above (talking points + value prop) but DO NOT just paste them — personalise.\n- Pick ONE approved anchor text from the list when mentioning the resource link.' : ''}

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
