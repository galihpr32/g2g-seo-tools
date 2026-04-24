import { createServiceClient } from '@/lib/supabase/service'
import { getDomainKeywords, getDomainOverview } from '@/lib/semrush/client'

/**
 * Loki — Competitive Analysis Agent
 *
 * Logic:
 * 1. Get competitor list from DB
 * 2. Keyword gap analysis: find keywords competitors rank top 10 but we don't
 * 3. SOV delta: compare market share vs previous period
 * 4. FireCrawl top competitor pages: analyze content depth/quality
 * 5. Queue agent_actions for findings
 */
export async function runLoki(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const db = createServiceClient()

  try {
    // 1. Get competitor list
    const { data: competitors, error: compErr } = await db
      .from('competitors')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('active', true)

    if (compErr || !competitors?.length) {
      return {
        summary: 'No active competitors configured.',
        actionsQueued: 0,
      }
    }

    const siteUrl = 'https://g2g.com' // Hardcoded for now

    let actionsQueued = 0
    const findings: string[] = []

    // 2. Keyword gap analysis (max 3 competitors)
    const topCompetitors = competitors.slice(0, 3)

    // Build branded keyword blocklist from all competitor domains + G2G own brand
    // e.g. "eldorado.gg" → blocks "eldorado", "eldorado.gg", "eldorado gg"
    const brandedTerms = new Set<string>(['g2g', 'g2g.com'])
    for (const c of competitors) {
      const domain = c.domain.toLowerCase()
      brandedTerms.add(domain)                          // e.g. "eldorado.gg"
      brandedTerms.add(domain.split('.')[0])            // e.g. "eldorado"
      brandedTerms.add(domain.replace(/\./g, ' '))      // e.g. "eldorado gg"
    }

    const isBrandedKeyword = (keyword: string): boolean => {
      const kw = keyword.toLowerCase()
      for (const term of brandedTerms) {
        if (kw.includes(term)) return true
      }
      return false
    }

    try {
      // Get our keywords
      const ourKeywords = await getDomainKeywords('g2g.com', 'us', 100)
      const ourRankings = new Map(ourKeywords.map(k => [k.keyword.toLowerCase(), k]))

      // For each competitor, find gap keywords
      for (const competitor of topCompetitors) {
        const compKeywords = await getDomainKeywords(competitor.domain, 'us', 100)

        const gaps = compKeywords.filter(ck => {
          const ourRanking = ourRankings.get(ck.keyword.toLowerCase())
          // Gap: they rank top 10, we rank >20 or don't rank
          // Also skip branded keywords (competitor brand names, our brand, etc.)
          return ck.position <= 10
            && (!ourRanking || ourRanking.position > 20)
            && !isBrandedKeyword(ck.keyword)
        })

        // Queue top gaps (by search volume)
        for (const gap of gaps.slice(0, 3)) {
          const priority = gap.searchVolume > 1000 ? 'high' : 'medium'

          const { error: insertErr } = await db
            .from('agent_actions')
            .insert({
              owner_user_id: ownerId,
              agent_key: 'loki',
              run_id: runId,
              site_slug: siteSlug,
              action_type: 'add_action_item',
              title: `Keyword gap: "${gap.keyword}" — ${competitor.domain} ranks #${gap.position}, we don't`,
              description: `${competitor.domain} ranks #${gap.position} for "${gap.keyword}" (${gap.searchVolume} monthly searches). We don't rank. CPC: $${gap.cpc.toFixed(2)}. Recommend on-page optimization.`,
              priority,
              data: {
                keyword: gap.keyword,
                competitor_domain: competitor.domain,
                competitor_position: gap.position,
                our_position: null,
                search_volume: gap.searchVolume,
                cpc: gap.cpc,
                action_type: 'on_page',
              },
            })

          if (!insertErr) {
            actionsQueued++
            findings.push(`Found keyword gap: "${gap.keyword}" (${gap.searchVolume} vol, competitor #${gap.position})`)
          }
        }
      }
    } catch (gapErr) {
      // Keyword gap analysis failed — log but continue
      console.warn('[loki] Keyword gap analysis failed:', gapErr)
    }

    // 3. SOV delta analysis
    try {
      // Get latest 30-day SERP snapshots
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10)

      const { data: recentSerps } = await db
        .from('serp_snapshots')
        .select('keyword, domain, position')
        .gte('snapshot_date', thirtyDaysAgo)

      const { data: olderSerps } = await db
        .from('serp_snapshots')
        .select('keyword, domain, position')
        .gte('snapshot_date', sixtyDaysAgo)
        .lt('snapshot_date', thirtyDaysAgo)

      if (recentSerps && recentSerps.length > 0) {
        // Calculate SOV: count top 10 positions for each domain
        const recentSOV = new Map<string, number>()
        const olderSOV = new Map<string, number>()

        for (const s of recentSerps) {
          if (s.position <= 10) {
            recentSOV.set(s.domain, (recentSOV.get(s.domain) ?? 0) + 1)
          }
        }

        for (const s of olderSerps ?? []) {
          if (s.position <= 10) {
            olderSOV.set(s.domain, (olderSOV.get(s.domain) ?? 0) + 1)
          }
        }

        // Check if our SOV dropped or competitors' SOV grew
        const ourRecent = recentSOV.get('g2g.com') ?? 0
        const ourOlder = olderSOV.get('g2g.com') ?? 0
        const sovChange = ourRecent - ourOlder

        if (sovChange < -5) {
          // Significant drop
          const topGainer = Array.from(recentSOV.entries())
            .filter(([d]) => competitors.some(c => c.domain === d))
            .sort((a, b) => b[1] - a[1])[0]

          if (topGainer) {
            const { error: insertErr } = await db
              .from('agent_actions')
              .insert({
                owner_user_id: ownerId,
                agent_key: 'loki',
                run_id: runId,
                site_slug: siteSlug,
                action_type: 'add_action_item',
                title: `SOV dropped ${Math.abs(sovChange)} positions — ${topGainer[0]} gained`,
                description: `Our SERP visibility dropped by ${Math.abs(sovChange)} top-10 positions in the last 30 days. ${topGainer[0]} has gained. Recommend competitive page review and content updates.`,
                priority: 'high',
                data: {
                  sov_change: sovChange,
                  top_gainer: topGainer[0],
                  our_recent_sov: ourRecent,
                  our_older_sov: ourOlder,
                  action_type: 'off_page',
                },
              })

            if (!insertErr) {
              actionsQueued++
              findings.push(`SOV dropped ${Math.abs(sovChange)} positions (top gainer: ${topGainer[0]})`)
            }
          }
        }
      }
    } catch (sovErr) {
      console.warn('[loki] SOV analysis failed:', sovErr)
    }

    // 4. FireCrawl competitor page analysis (if API available)
    const hasCrawlAPI = !!process.env.FIRECRAWL_API_KEY && process.env.FIRECRAWL_API_KEY !== 'placeholder'

    if (hasCrawlAPI) {
      try {
        for (const competitor of topCompetitors.slice(0, 1)) {
          // For now, just log that we would crawl
          // Full FireCrawl integration deferred to later phase
          findings.push(`Competitor analysis ready for ${competitor.domain} (FireCrawl integration pending)`)
        }
      } catch (crawlErr) {
        console.warn('[loki] FireCrawl analysis failed:', crawlErr)
      }
    }

    // Cap actions to 10 per run
    const totalActions = actionsQueued
    const cappedNote = totalActions > 10 ? ' (capped at 10)' : ''
    const summary = `Analyzed ${topCompetitors.length} competitors. Found ${findings.length} insights. Queued ${Math.min(totalActions, 10)} actions${cappedNote}.`

    // Update run record
    await db
      .from('agent_runs')
      .update({
        status: 'success',
        summary,
        findings_count: findings.length,
        actions_queued: Math.min(actionsQueued, 10),
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)

    // Update agent last_run
    await db
      .from('agents')
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: 'success',
        last_run_summary: summary,
      })
      .eq('owner_user_id', ownerId)
      .eq('agent_key', 'loki')

    return { summary, actionsQueued: Math.min(totalActions, 10) }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'

    // Update run with error
    await db
      .from('agent_runs')
      .update({
        status: 'error',
        error_message: errorMessage,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId)

    // Update agent
    await db
      .from('agents')
      .update({
        last_run_at: new Date().toISOString(),
        last_run_status: 'error',
        last_run_summary: errorMessage,
      })
      .eq('owner_user_id', ownerId)
      .eq('agent_key', 'loki')

    throw err
  }
}
