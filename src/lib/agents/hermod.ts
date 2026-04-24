import { createServiceClient } from '@/lib/supabase/service'

/**
 * Hermod — Off-Page / Outreach Agent
 *
 * Logic:
 * 1. Pull recently approved keyword-gap actions from Intel Bakso
 * 2. For each gap, check serp_snapshots for sites ranking for that keyword
 * 3. Cross-reference with existing outreach_prospects to avoid duplicates
 * 4. Generate a tailored outreach pitch per prospect
 * 5. Queue draft_outreach actions (max 8 per run)
 */
export async function runHermod(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{ summary: string; actionsQueued: number }> {
  const db = createServiceClient()

  try {
    // 1. Get recently approved keyword-gap intel from Intel Bakso (last 14 days)
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: gapActions } = await db
      .from('agent_actions')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('agent_key', 'loki')
      .eq('action_type', 'add_action_item')
      .in('status', ['approved', 'executed'])
      .gte('created_at', fourteenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(10)

    if (!gapActions?.length) {
      const summary = 'No recent Intel Bakso keyword gaps to work with. Run Intel Bakso first.'
      await _finishRun(db, runId, ownerId, 'success', summary, 0, 0)
      return { summary, actionsQueued: 0 }
    }

    // 2. Load known competitors and existing outreach domains to skip
    const { data: competitors } = await db
      .from('competitors')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const { data: existingProspects } = await db
      .from('outreach_prospects')
      .select('domain')
      .eq('owner_user_id', ownerId)

    const skipDomains = new Set([
      'g2g.com',
      ...(competitors?.map(c => c.domain) ?? []),
      ...(existingProspects?.map(p => p.domain) ?? []),
    ])

    // 3. Also check for already-pending draft_outreach actions this session
    const { data: pendingOutreach } = await db
      .from('agent_actions')
      .select('data')
      .eq('owner_user_id', ownerId)
      .eq('action_type', 'draft_outreach')
      .eq('status', 'pending')

    for (const o of pendingOutreach ?? []) {
      const d = o.data as Record<string, unknown>
      if (d.domain) skipDomains.add(String(d.domain))
    }

    let actionsQueued = 0
    const findings: string[] = []
    const processedKeywords = new Set<string>()

    for (const action of gapActions) {
      if (actionsQueued >= 8) break

      const d = action.data as Record<string, unknown>
      const keyword          = String(d.keyword ?? '')
      const competitorDomain = String(d.competitor_domain ?? '')
      const searchVolume     = Number(d.search_volume ?? 0)
      const targetPage       = `https://g2g.com/categories/${keyword.toLowerCase().replace(/\s+/g, '-')}`

      if (!keyword || processedKeywords.has(keyword)) continue
      processedKeywords.add(keyword)

      // 4a. Find sites ranking for this keyword from SERP snapshots
      const { data: serpRows } = await db
        .from('serp_snapshots')
        .select('domain, position')
        .ilike('keyword', keyword)
        .lte('position', 15)
        .order('position', { ascending: true })
        .limit(10)

      // 4b. Candidates: SERP snapshot sites + the competitor Intel Bakso found
      const candidateDomains: { domain: string; position: number; source: string }[] = []

      for (const row of serpRows ?? []) {
        if (row.domain && !skipDomains.has(row.domain)) {
          candidateDomains.push({ domain: row.domain, position: row.position, source: 'serp' })
        }
      }

      // Add competitor domain as an outreach candidate if not already tracked
      if (competitorDomain && !skipDomains.has(competitorDomain) && !candidateDomains.find(c => c.domain === competitorDomain)) {
        candidateDomains.push({ domain: competitorDomain, position: Number(d.competitor_position ?? 5), source: 'loki' })
      }

      // Take top 2 candidates per keyword
      for (const candidate of candidateDomains.slice(0, 2)) {
        if (actionsQueued >= 8) break
        skipDomains.add(candidate.domain) // avoid same domain twice

        const angle    = buildOutreachAngle(keyword, candidate.domain, targetPage, searchVolume)
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
              target_url:       targetPage,
              topic:            angle.topic,
              draft_email:      angle.email,
              source:           candidate.source,
              source_action_id: action.id,
            },
          })

        if (!insertErr) {
          actionsQueued++
          findings.push(`${candidate.domain} → "${keyword}"`)
        }
      }

      // If no SERP/competitor data, queue a self-sourced prospect for manual research
      if (candidateDomains.length === 0 && actionsQueued < 8) {
        const angle    = buildOutreachAngle(keyword, 'manual-research', targetPage, searchVolume)
        const priority = searchVolume > 5000 ? 'high' : 'medium'

        await db.from('agent_actions').insert({
          owner_user_id: ownerId,
          agent_key:     'hermod',
          run_id:        runId,
          site_slug:     siteSlug,
          action_type:   'draft_outreach',
          title:         `Outreach opportunity: "${keyword}" (${searchVolume.toLocaleString()} searches) — find prospects`,
          description:   `G2G doesn't rank for "${keyword}". Recommend finding outreach prospects manually for this keyword.`,
          priority,
          data: {
            domain:           '',
            keyword,
            search_volume:    searchVolume,
            target_url:       targetPage,
            topic:            angle.topic,
            draft_email:      '',
            source:           'suggestion',
            source_action_id: action.id,
          },
        })
        actionsQueued++
        findings.push(`"${keyword}" (manual research needed)`)
      }
    }

    const summary = actionsQueued > 0
      ? `Found ${actionsQueued} outreach prospect${actionsQueued !== 1 ? 's' : ''} across ${processedKeywords.size} keyword gaps: ${findings.slice(0, 3).join(', ')}${findings.length > 3 ? '…' : ''}`
      : `Scanned ${processedKeywords.size} keyword gap${processedKeywords.size !== 1 ? 's' : ''} — all domains already in tracker.`

    await _finishRun(db, runId, ownerId, 'success', summary, findings.length, actionsQueued)
    return { summary, actionsQueued }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', errorMessage, 0, 0, errorMessage)
    throw err
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface OutreachAngle {
  topic: string
  pitch: string
  email: string
}

function buildOutreachAngle(keyword: string, domain: string, targetUrl: string, searchVolume: number): OutreachAngle {
  const gameName = keyword
    .replace(/\s+(buy|gold|currency|items|coins|boost|account|cd\s*key)\b.*/i, '')
    .trim()

  const isBuy  = /buy|purchase|cheap|price/i.test(keyword)
  const isGuide = /guide|how\s+to|tips|best/i.test(keyword)

  if (isBuy) {
    return {
      topic: `G2G Marketplace Mention — ${keyword}`,
      pitch: `${domain} ranks for "${keyword}" (${searchVolume.toLocaleString()} searches/mo). Pitch: include G2G as the recommended marketplace for ${gameName} items.`,
      email: `Hi,

I came across your page ranking for "${keyword}" and wanted to reach out.

G2G.com is the world's leading marketplace for ${gameName} currency and items — trusted by millions of players globally with the best prices and instant delivery.

We'd love to be featured as a recommended resource on your page. Would you be open to a collaboration?

Happy to discuss details — feel free to reply here.

Best regards`,
    }
  }

  if (isGuide) {
    return {
      topic: `Resource Link for ${gameName} Guide`,
      pitch: `${domain} ranks for "${keyword}". Pitch: add G2G as a resource where readers can buy ${gameName} items to follow the guide.`,
      email: `Hi,

Your guide on "${keyword}" is really helpful — great work!

I noticed it could benefit from a resource link where readers can get ${gameName} items quickly to follow along. G2G.com is the #1 trusted marketplace for this, with the best prices and instant delivery.

Would you consider adding G2G as a recommended resource? We'd love to support your content.

Best regards`,
    }
  }

  return {
    topic: `G2G Partnership for ${gameName} Content`,
    pitch: `${domain} covers content related to "${keyword}". Pitch: partnership or mention as the go-to marketplace for ${gameName}.`,
    email: `Hi,

I noticed your site covers ${gameName} and ranks well for related searches.

G2G.com is the world's largest peer-to-peer gaming marketplace — if your audience plays ${gameName}, they'd find G2G invaluable for buying in-game items, currency, and accounts at the best prices.

Would you be interested in exploring a partnership or editorial mention? We're flexible on format.

Best regards`,
  }
}

async function _finishRun(
  db: ReturnType<typeof createServiceClient>,
  runId: string,
  ownerId: string,
  status: 'success' | 'error',
  summary: string,
  findingsCount: number,
  actionsQueued: number,
  errorMessage?: string
) {
  await db.from('agent_runs').update({
    status,
    summary,
    findings_count: findingsCount,
    actions_queued: actionsQueued,
    error_message:  errorMessage ?? null,
    finished_at:    new Date().toISOString(),
  }).eq('id', runId)

  await db.from('agents').update({
    last_run_at:      new Date().toISOString(),
    last_run_status:  status,
    last_run_summary: summary,
  }).eq('owner_user_id', ownerId).eq('agent_key', 'hermod')
}
