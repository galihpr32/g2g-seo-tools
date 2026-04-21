import { createServiceClient } from '@/lib/supabase/service'

/**
 * Mas Gacor (Trend Spotter) — identifies trending games and queues brief suggestions.
 *
 * Logic:
 * 1. Read from game_trends_cache (last 24h or fetch fresh)
 * 2. For each trending game, enrich with Steam Store data (sale, recent update)
 * 3. Check if we already have a brief or action item
 * 4. Queue agent_actions with suggest_trend_brief
 */

interface TrendReason {
  type: 'sale' | 'update' | 'new_release' | 'high_concurrency' | 'search_spike'
  detail: string
}

/**
 * Fetch trend reasons for a game from Steam Store API (free, no key required).
 * Returns up to 2 reasons: sale status + latest news headline.
 */
async function fetchTrendReasons(appId: number, gameName: string, players2weeks: number): Promise<TrendReason[]> {
  const reasons: TrendReason[] = []

  try {
    // Check sale status via Steam Store API
    const priceRes = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=price_overview`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (priceRes.ok) {
      const priceData = await priceRes.json() as Record<string, { success: boolean; data?: { price_overview?: { discount_percent: number } } }>
      const discount = priceData[String(appId)]?.data?.price_overview?.discount_percent ?? 0
      if (discount >= 20) {
        reasons.push({ type: 'sale', detail: `Steam sale: ${discount}% off` })
      }
    }
  } catch { /* ignore timeout */ }

  try {
    // Check latest news for update/DLC/event signals
    const newsRes = await fetch(
      `https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=2&maxlength=120&format=json`,
      { signal: AbortSignal.timeout(5000) }
    )
    if (newsRes.ok) {
      const newsData = await newsRes.json() as { appnews?: { newsitems?: { title: string; date: number }[] } }
      const items = newsData.appnews?.newsitems ?? []
      const recent = items.filter(n => {
        const ageHours = (Date.now() / 1000 - n.date) / 3600
        return ageHours < 168 // last 7 days
      })
      if (recent.length > 0) {
        const title = recent[0].title
        const isUpdate = /update|patch|hotfix|fix|v\d|version|\d+\.\d+/i.test(title)
        const isDLC = /dlc|expansion|content|season|pass/i.test(title)
        const isEvent = /event|festival|weekend|free|limited/i.test(title)
        const type = isUpdate ? 'update' : isDLC ? 'new_release' : 'update'
        const label = isDLC ? 'New DLC/content' : isEvent ? 'Live event' : isUpdate ? 'Recent update' : 'Recent news'
        reasons.push({ type, detail: `${label}: "${title.slice(0, 60)}${title.length > 60 ? '…' : ''}"` })
      }
    }
  } catch { /* ignore timeout */ }

  // Always add concurrency as a baseline reason if high
  if (players2weeks > 50000) {
    reasons.push({ type: 'high_concurrency', detail: `${(players2weeks / 1000).toFixed(0)}K peak concurrent players` })
  }

  return reasons.slice(0, 2)
}
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

    // Helper to check for existing GSC pages containing a game name
    async function checkExistingPage(gameName: string, siteUrl: string) {
      const gameSlug = gameName.toLowerCase().replace(/\s+/g, '-')
      const { data: rankings } = await db
        .from('gsc_ranking_snapshots')
        .select('page')
        .eq('site_url', siteUrl)
        .filter('page', 'ilike', `%${gameSlug}%`)
        .limit(1)
        .single()

      return rankings?.page ?? null
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

      // Check for existing page in GSC rankings
      const existingPageUrl = await checkExistingPage(game.name, siteUrl)

      // Determine priority based on trend score
      const totalScore = (game.search_volume || 0) + (game.players_2weeks || 0) / 100
      let priority: 'high' | 'medium' | 'low' = 'low'
      if (totalScore > 10000) priority = 'high'
      else if (totalScore > 5000) priority = 'medium'

      // Fetch trend reasons from Steam (sale, update, news) for top games only
      const trendReasons = game.steam_appid && priority !== 'low'
        ? await fetchTrendReasons(game.steam_appid, game.name, game.players_2weeks || 0)
        : []

      // Build trend basis description
      const basisParts: string[] = []
      if (trendReasons.length > 0) {
        basisParts.push(...trendReasons.map(r => r.detail))
      } else {
        if (game.players_2weeks && game.players_2weeks > 0) {
          basisParts.push(`${(game.players_2weeks / 1000).toFixed(0)}K peak concurrent players on Steam`)
        }
        if (game.search_volume && game.search_volume > 0) {
          basisParts.push(`${game.search_volume.toLocaleString()} monthly searches`)
        }
      }
      const trendBasis = basisParts.length > 0 ? basisParts.join(' · ') : 'Trending on Steam'
      const trendReasonTypes = trendReasons.map(r => r.type)

      // Determine suggested action
      let suggestedAction: 'create_page' | 'update_page' | 'brief_exists'
      if (existingPageUrl) {
        suggestedAction = 'update_page'
      } else {
        suggestedAction = 'create_page'
      }

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key: 'mas-gacor',
          run_id: runId,
          site_slug: siteSlug,
          action_type: 'suggest_trend_brief',
          title: `"${game.name}" is trending — ${suggestedAction === 'create_page' ? 'create' : 'update'} category page`,
          description: `Why trending: ${trendBasis}. ${suggestedAction === 'create_page' ? 'No category page exists yet — create one to capture this demand.' : 'Category page exists — consider updating content to match current demand.'}`,
          priority,
          data: {
            game_name: game.name,
            steam_appid: game.steam_appid,
            trend_score: totalScore,
            search_volume: game.search_volume || 0,
            players_2weeks: game.players_2weeks || 0,
            buy_search_volume: game.buy_search_volume || 0,
            keywords: [],
            trend_basis: trendBasis,
            trend_reasons: trendReasonTypes,
            existing_page_url: existingPageUrl,
            suggested_action: suggestedAction,
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
