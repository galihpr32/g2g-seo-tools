import { createServiceClient } from '@/lib/supabase/service'

/**
 * Mas Gacor (Trend Spotter) — identifies trending games and queues brief suggestions.
 *
 * Logic:
 * 1. Read from game_trends_cache (last 24h or fetch fresh)
 * 2. For each trending game, check if we already have a brief or action item
 * 3. Queue agent_actions with suggest_trend_brief
 */
export async function runMasGacor(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const db = createServiceClient()

  try {
    // 1. Read game trends from cache
    const { data: trends, error: trendsErr } = await db
      .from('game_trends_cache')
      .select('*')
      .order('players_2weeks', { ascending: false })
      .limit(50)

    if (trendsErr || !trends?.length) {
      return {
        summary: 'No trending games to analyze.',
        actionsQueued: 0,
      }
    }

    // 2. Get site config
    const { data: siteConfig, error: siteErr } = await db
      .from('site_configs')
      .select('id, slug, display_name')
      .eq('slug', siteSlug)
      .single()

    if (siteErr || !siteConfig) {
      throw new Error(`Site config not found for slug: ${siteSlug}`)
    }

    const siteUrl = `https://g2g.com`  // Hardcoded for G2G for now

    // 3. Check existing briefs and action items
    const gameNames = trends.map(t => t.name)
    const { data: existingBriefs } = await db
      .from('seo_content_briefs')
      .select('page_url')
      .eq('site_url', siteUrl)

    const { data: existingActions } = await db
      .from('seo_action_items')
      .select('page')
      .eq('site_url', siteUrl)
      .in('status', ['pending', 'in_progress'])

    const existingPages = new Set([
      ...(existingBriefs?.map(b => b.page_url) || []),
      ...(existingActions?.map(a => a.page) || []),
    ])

    // 4. Queue agent_actions for high-trending games
    let actionsQueued = 0

    for (const game of trends.slice(0, 20)) {
      // Only check top 20 to avoid explosion
      const categoryPageUrl = `${siteUrl}/categories/${game.name.toLowerCase().replace(/\s+/g, '-')}`

      // Skip if already has brief or action
      if (existingPages.has(categoryPageUrl)) {
        continue
      }

      // Calculate trend basis
      const basisParts: string[] = []
      if (game.search_volume && game.search_volume > 100) {
        basisParts.push(`Search volume: ${game.search_volume.toLocaleString()}`)
      }
      if (game.players_2weeks && game.players_2weeks > 10000) {
        basisParts.push(`Steam players (2w): ${game.players_2weeks.toLocaleString()}`)
      }
      if (game.buy_search_volume && game.buy_search_volume > 50) {
        basisParts.push(`"${game.name} buy" searches: ${game.buy_search_volume}`)
      }

      const trendBasis = basisParts.length > 0 ? basisParts.join(' | ') : 'Steam trending'

      // Determine priority based on trend score
      const totalScore = (game.search_volume || 0) + (game.players_2weeks || 0) / 100
      let priority: 'high' | 'medium' | 'low' = 'low'
      if (totalScore > 10000) priority = 'high'
      else if (totalScore > 5000) priority = 'medium'

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key: 'mas-gacor',
          run_id: runId,
          site_slug: siteSlug,
          action_type: 'suggest_trend_brief',
          title: `"${game.name}" is trending — create/update category page`,
          description: `Game is trending with ${trendBasis}. Consider creating or updating the category page to capture demand.`,
          priority,
          data: {
            game_name: game.name,
            steam_appid: game.steam_appid,
            trend_score: totalScore,
            search_volume: game.search_volume || 0,
            players_2weeks: game.players_2weeks || 0,
            buy_search_volume: game.buy_search_volume || 0,
            keywords: [],
            basis: game.search_volume ? 'search_volume' : 'steam_trending',
            existing_page_url: null,
          },
        })

      if (!insertErr) actionsQueued++
    }

    const summary = `Analyzed ${trends.length} trending games. Found ${actionsQueued} new opportunities.`

    // Update run record
    await db
      .from('agent_runs')
      .update({
        status: 'success',
        summary,
        findings_count: trends.length,
        actions_queued: actionsQueued,
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
      .eq('agent_key', 'mas-gacor')

    return { summary, actionsQueued }
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
      .eq('agent_key', 'mas-gacor')

    throw err
  }
}
