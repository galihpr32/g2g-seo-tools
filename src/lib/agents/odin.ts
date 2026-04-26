import { createServiceClient } from '@/lib/supabase/service'
import { getSiteUrlForSlug, buildCategoryUrl, normalizeUrl } from '@/lib/agents/site-helpers'
import { lookupKeywordInUniverse } from '@/lib/agents/universe-helpers'

/**
 * Odin (Trend Spotter) — identifies trending games and queues brief suggestions.
 *
 * Logic:
 * 1. Read from game_trends_cache (warn if cache is stale > 24h)
 * 2. For each candidate game, enrich with Steam Store data — RETRIES once on
 *    timeout. If Steam still fails for a game, skip it (don't queue an action
 *    with empty trend reasons that read as a hallucination).
 * 3. Check if we already have a brief or action item (URL-normalized dedup)
 * 4. Queue agent_actions with suggest_trend_brief
 */

interface TrendReason {
  type: 'sale' | 'update' | 'new_release' | 'high_concurrency' | 'search_spike' | 'live_event'
  detail: string
}

const STEAM_TIMEOUT_MS = 5000
const STEAM_RETRY      = 1   // attempts beyond the first
const CACHE_MAX_AGE_HOURS = 24

async function fetchWithRetry(url: string, attempts = STEAM_RETRY + 1): Promise<Response | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(STEAM_TIMEOUT_MS) })
      if (res.ok) return res
    } catch {
      // try again
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)))
  }
  return null
}

/**
 * Pulls trend reasons from Steam Store + News API. Returns null on total
 * failure so the caller can decide whether to skip the game.
 */
async function fetchTrendReasons(
  appId: number,
  players2weeks: number
): Promise<{ reasons: TrendReason[]; steamHit: boolean }> {
  const reasons: TrendReason[] = []
  let steamHit = false

  // Sale status
  const priceRes = await fetchWithRetry(
    `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=price_overview`
  )
  if (priceRes) {
    steamHit = true
    try {
      const priceData = await priceRes.json() as Record<string, { success: boolean; data?: { price_overview?: { discount_percent: number; final_formatted?: string } } }>
      const overview = priceData[String(appId)]?.data?.price_overview
      if (overview && overview.discount_percent >= 20) {
        reasons.push({ type: 'sale', detail: `Steam sale: ${overview.discount_percent}% off${overview.final_formatted ? ` (${overview.final_formatted})` : ''}` })
      }
    } catch { /* swallow parse error, retain steamHit */ }
  }

  // Latest news
  const newsRes = await fetchWithRetry(
    `https://api.steampowered.com/ISteamNews/GetNewsForApp/v0002/?appid=${appId}&count=2&maxlength=120&format=json`
  )
  if (newsRes) {
    steamHit = true
    try {
      const newsData = await newsRes.json() as { appnews?: { newsitems?: { title: string; date: number }[] } }
      const items = newsData.appnews?.newsitems ?? []
      const recent = items.filter(n => (Date.now() / 1000 - n.date) / 3600 < 168)  // last 7d
      if (recent.length > 0) {
        const title = recent[0].title
        const isUpdate = /update|patch|hotfix|fix|v\d|version|\d+\.\d+/i.test(title)
        const isDLC    = /dlc|expansion|content|season|pass/i.test(title)
        const isEvent  = /event|festival|weekend|free|limited/i.test(title)
        const type: TrendReason['type'] = isDLC ? 'new_release' : isEvent ? 'live_event' : 'update'
        const label = isDLC ? 'New DLC/content' : isEvent ? 'Live event' : isUpdate ? 'Recent update' : 'Recent news'
        reasons.push({ type, detail: `${label}: "${title.slice(0, 60)}${title.length > 60 ? '…' : ''}"` })
      }
    } catch { /* swallow parse error */ }
  }

  // Concurrency baseline (always derivable from cached data, no API needed)
  if (players2weeks > 50000) {
    reasons.push({ type: 'high_concurrency', detail: `${(players2weeks / 1000).toFixed(0)}K peak concurrent players` })
  }

  return { reasons: reasons.slice(0, 3), steamHit }
}

export async function runOdin(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{ summary: string; actionsQueued: number }> {
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    // 0. Site
    const site = await getSiteUrlForSlug(db, siteSlug)
    const siteUrl = site.siteUrl

    // 1. Read game trends from cache + freshness check
    const { data: trends, error: trendsErr } = await db
      .from('game_trends_cache')
      .select('*')
      .order('players_2weeks', { ascending: false })
      .limit(50)

    if (trendsErr) throw new Error(`game_trends_cache query failed: ${trendsErr.message}`)
    if (!trends?.length) {
      const summary = 'No trending games to analyze. Populate game_trends_cache first.'
      await _finishRun(db, runId, ownerId, 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    // Freshness: use the freshest updated_at (or cached_at) timestamp on rows
    const newestTs = trends
      .map(t => (t.updated_at ?? t.cached_at ?? t.created_at) as string | undefined)
      .filter((s): s is string => Boolean(s))
      .map(s => new Date(s).getTime())
      .sort((a, b) => b - a)[0]

    if (newestTs) {
      const ageHours = (Date.now() - newestTs) / (1000 * 60 * 60)
      if (ageHours > CACHE_MAX_AGE_HOURS) {
        warnings.push(`game_trends_cache is ${ageHours.toFixed(1)}h old (threshold ${CACHE_MAX_AGE_HOURS}h) — refresh may be stale`)
      }
    }

    // 2. Get site config (already done via getSiteUrlForSlug)
    // 3. Existing pages (URL-normalized)
    const { data: existingBriefs } = await db
      .from('seo_content_briefs')
      .select('page')
      .eq('site_url', siteUrl)

    const { data: existingActions } = await db
      .from('seo_action_items')
      .select('page')
      .eq('site_url', siteUrl)
      .in('status', ['pending', 'in_progress'])

    const existingPagesNorm = new Set([
      ...(existingBriefs?.map(b => normalizeUrl(b.page)) ?? []),
      ...(existingActions?.map(a => normalizeUrl(a.page)) ?? []),
    ])

    let actionsQueued    = 0
    let steamFailures    = 0
    let skippedNoContext = 0
    let skippedExisting  = 0

    // 4. For each candidate game (top 20 by concurrent players)
    for (const game of trends.slice(0, 20)) {
      const categoryPageUrl = buildCategoryUrl(siteUrl, String(game.name))
      if (existingPagesNorm.has(normalizeUrl(categoryPageUrl))) {
        skippedExisting++
        continue
      }

      // Existing GSC ranking? Use maybeSingle so a no-row miss doesn't throw.
      const gameSlug = String(game.name).toLowerCase().replace(/\s+/g, '-')
      const { data: rankings } = await db
        .from('gsc_ranking_snapshots')
        .select('page')
        .eq('site_url', siteUrl)
        .filter('page', 'ilike', `%${gameSlug}%`)
        .limit(1)
        .maybeSingle()

      const existingPageUrl: string | null = rankings?.page ?? null

      const sv  = Number(game.search_volume  ?? 0)
      const p2w = Number(game.players_2weeks ?? 0)
      const svScore  = sv  > 0 ? Math.log10(sv  + 1) : 0
      const p2wScore = p2w > 0 ? Math.log10(p2w + 1) : 0

      // Priority bands — calibrated for a gaming MARKETPLACE (niche games with
      // small but active audiences are valuable too, not just AAA titles).
      //   high   = sv ≥3.2k AND p2w ≥10k        (clear AAA / mass appeal)
      //   medium = sv ≥500   OR  p2w ≥5k        (niche but commercial)
      //   low    = anything below
      let priority: 'high' | 'medium' | 'low' = 'low'
      if (svScore >= 3.5 && p2wScore >= 4)         priority = 'high'
      else if (svScore >= 2.7 || p2wScore >= 3.7)  priority = 'medium'
      const composite = svScore + p2wScore

      // Always fetch Steam reasons when an appid exists — Steam API is free,
      // even a low-priority game with a 50% sale or new DLC is a valid trend
      // signal we don't want to miss. The retry/timeout logic handles failure
      // gracefully (returns empty reasons + steamHit=false).
      let trendReasons: TrendReason[] = []
      let steamHit = false
      if (game.steam_appid) {
        const r = await fetchTrendReasons(Number(game.steam_appid), p2w)
        trendReasons = r.reasons
        steamHit = r.steamHit
        if (!steamHit) steamFailures++
      }

      // Permissive context check: if a game made it into the trending cache,
      // it deserves a chance. Skip ONLY if literally every signal is empty:
      // no search volume, no concurrent players, no Steam reasons.
      const hasMeaningfulContext = trendReasons.length > 0 || sv > 0 || p2w > 2000
      if (!hasMeaningfulContext) {
        skippedNoContext++
        continue
      }

      // Build trend basis
      const basisParts: string[] = []
      basisParts.push(...trendReasons.map(r => r.detail))
      if (p2w > 0 && !trendReasons.some(r => r.type === 'high_concurrency')) {
        basisParts.push(`${(p2w / 1000).toFixed(0)}K peak concurrent players on Steam`)
      }
      if (sv > 0) basisParts.push(`${sv.toLocaleString()} monthly searches for "${game.name}"`)
      const trendBasis = basisParts.join(' · ')

      const suggestedAction: 'create_page' | 'update_page' = existingPageUrl ? 'update_page' : 'create_page'
      // Fast-path: high-priority NEW trend (no existing page) → handoff to
      // Bragi directly. Skips the suggest_trend_brief → manual approve →
      // Bragi-scan three-step. One approval = one brief.
      const isFastPath = priority === 'high' && suggestedAction === 'create_page'

      const description = [
        `Why trending: ${trendBasis}.`,
        suggestedAction === 'create_page'
          ? `No category page exists yet — create one to capture this demand.`
          : `Existing page (${existingPageUrl}) — refresh content to match current demand.`,
        !steamHit && game.steam_appid ? '(Steam enrichment unavailable — using cached signals only.)' : '',
        isFastPath ? '⚡ Approve to auto-draft a brief via Bragi.' : '',
      ].filter(Boolean).join(' ')

      // Soft universe enforcement: tag with topic match if any.
      const universe = await lookupKeywordInUniverse(db, ownerId, String(game.name))

      const sharedData = {
        game_name:         game.name,
        steam_appid:       game.steam_appid,
        trend_score:       composite,
        search_volume:     sv,
        players_2weeks:    p2w,
        buy_search_volume: game.buy_search_volume || 0,
        keywords:          [],
        trend_basis:       trendBasis,
        trend_reasons:     trendReasons.map(r => r.type),
        trend_reason_details: trendReasons,
        steam_enriched:    steamHit,
        existing_page_url: existingPageUrl,
        suggested_action:  suggestedAction,
        page_url:          categoryPageUrl,
        keyword_map_cluster_id: universe.keyword_map_cluster_id,
        keyword_map_id:         universe.keyword_map_id,
        topic:                  universe.topic,
        outside_universe:       universe.outside_universe,
      }

      let insertErr
      if (isFastPath) {
        ;({ error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key: 'odin',
            run_id: runId,
            site_slug: siteSlug,
            action_type: 'run_agent',
            title: `⚡ Trending: "${game.name}" — draft category brief?`,
            description,
            priority: 'high',
            data: {
              handoff_to: 'bragi',
              context:    'odin_high_value_trend',
              payload: {
                keyword:       game.name,
                page_url:      categoryPageUrl,
                search_volume: sv,
                source_agent:  'odin',
                brief_type:    'category_page',
                context:       `Trending game basis: ${trendBasis}`,
              },
              ...sharedData,
              fast_path:     true,
            },
          }))
      } else {
        ;({ error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key: 'odin',
            run_id: runId,
            site_slug: siteSlug,
            action_type: 'suggest_trend_brief',
            title: `"${game.name}" is trending — ${suggestedAction === 'create_page' ? 'create' : 'update'} category page`,
            description,
            priority,
            data: sharedData,
          }))
      }

      if (insertErr) {
        console.error('[odin] insert failed:', insertErr.message)
      } else {
        actionsQueued++
      }
    }

    if (steamFailures > 0)    warnings.push(`Steam API enrichment failed for ${steamFailures} game(s)`)
    if (skippedNoContext > 0) warnings.push(`Skipped ${skippedNoContext} game(s) with no signals`)

    const breakdownParts = [`${actionsQueued} queued`]
    if (skippedExisting > 0)  breakdownParts.push(`${skippedExisting} skipped (already have page)`)
    if (skippedNoContext > 0) breakdownParts.push(`${skippedNoContext} skipped (no signals)`)
    const summaryBase = `Analyzed ${trends.length} trending games · ${breakdownParts.join(', ')}.`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase
    const status = warnings.length ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, summary, trends.length, actionsQueued, warnings)
    return { summary, actionsQueued }
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
    .eq('agent_key', 'odin')
}
