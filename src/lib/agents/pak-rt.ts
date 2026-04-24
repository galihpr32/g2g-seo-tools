import { createServiceClient } from '@/lib/supabase/service'

/**
 * Pak RT (Watchdog) — detects ranking drops and queues action items.
 *
 * Logic:
 * 1. Get GSC connection + site_url
 * 2. Fetch last 7 days of GSC ranking drops: compare this week vs previous week
 * 3. Find pages where clicks dropped > 5 AND clicks_drop% > 20%
 * 4. Filter out pages already in progress or with existing briefs
 * 5. Queue agent_actions for remaining pages
 */
export interface PakRTConfig {
  maxDropsPerDay: number      // max URLs to queue per run (default: 10)
  minClicksDrop: number       // minimum absolute click drop to consider (default: 5)
  minPctDrop: number          // minimum % drop to consider (default: 20)
}

export const PAK_RT_DEFAULTS: PakRTConfig = {
  maxDropsPerDay: 10,
  minClicksDrop: 5,
  minPctDrop: 20,
}

export async function runPakRT(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<PakRTConfig> = {}
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const { maxDropsPerDay, minClicksDrop, minPctDrop } = { ...PAK_RT_DEFAULTS, ...config }
  const db = createServiceClient()

  try {
    // 0. Trigger GSC sync to get fresh data before analyzing
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL
      const cronSecret = process.env.CRON_SECRET
      if (appUrl && cronSecret) {
        console.log('[pak-rt] Triggering GSC sync before analysis…')
        await fetch(`${appUrl}/api/cron/gsc-daily`, {
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        console.log('[pak-rt] GSC sync completed.')
      }
    } catch (syncErr) {
      // Non-fatal: if sync fails, continue with existing data
      console.warn('[pak-rt] GSC sync failed (continuing with cached data):', syncErr)
    }

    // 1. Get GSC connection
    const { data: conn, error: connErr } = await db
      .from('gsc_connections')
      .select('site_url')
      .eq('user_id', ownerId)
      .single()

    if (connErr || !conn?.site_url) {
      throw new Error('No GSC connection found')
    }

    const siteUrl = conn.site_url

    // 2. Fetch ranking drops from last 14 days
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)

    const { data: drops, error: dropsErr } = await db
      .from('gsc_ranking_drops')
      .select('*')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', fourteenDaysAgo)
      .order('snapshot_date', { ascending: true })

    if (dropsErr || !drops?.length) {
      return {
        summary: 'No ranking data to analyze.',
        actionsQueued: 0,
      }
    }

    // 3. Identify drops: compare first 7 days vs last 7 days
    const mid = Math.floor(drops.length / 2)
    const firstWeek = drops.slice(0, mid)
    const lastWeek = drops.slice(mid)

    const pageMetrics = new Map<string, { clicks_prev: number; clicks_now: number; pos_prev: number; pos_now: number }>()

    // Aggregate first week
    for (const drop of firstWeek) {
      const key = drop.page
      const current = pageMetrics.get(key) || { clicks_prev: 0, clicks_now: 0, pos_prev: 0, pos_now: 0 }
      current.clicks_prev += drop.clicks_now || 0
      current.pos_prev = drop.position || current.pos_prev
      pageMetrics.set(key, current)
    }

    // Aggregate last week and compute drops
    const significantDrops: Array<{
      page: string
      clicks_prev: number
      clicks_now: number
      clicks_drop: number
      clicks_drop_pct: number
      position_change: number
    }> = []

    for (const drop of lastWeek) {
      const key = drop.page
      const metrics = pageMetrics.get(key)
      if (!metrics) continue

      metrics.clicks_now += drop.clicks_now || 0
      metrics.pos_now = drop.position || metrics.pos_now

      const clicksDrop = metrics.clicks_prev - metrics.clicks_now
      const clicksDropPct = metrics.clicks_prev > 0
        ? (clicksDrop / metrics.clicks_prev) * 100
        : 0

      // Find drops where clicks_drop > minClicksDrop AND pct > minPctDrop
      if (clicksDrop > minClicksDrop && clicksDropPct > minPctDrop) {
        significantDrops.push({
          page: key,
          clicks_prev: metrics.clicks_prev,
          clicks_now: metrics.clicks_now,
          clicks_drop: clicksDrop,
          clicks_drop_pct: clicksDropPct,
          position_change: metrics.pos_now - metrics.pos_prev,
        })
      }
    }

    // 4. Filter out pages already in progress
    const pagesToCheck = significantDrops.map(d => d.page)
    let existingPages = new Set<string>()

    if (pagesToCheck.length > 0) {
      const { data: existing } = await db
        .from('seo_action_items')
        .select('page')
        .eq('site_url', siteUrl)
        .in('page', pagesToCheck)
        .in('status', ['pending', 'in_progress'])

      existingPages = new Set(existing?.map(e => e.page) || [])

      const { data: briefs } = await db
        .from('seo_content_briefs')
        .select('page_url')
        .eq('site_url', siteUrl)
        .in('page_url', pagesToCheck)

      const briefPages = new Set(briefs?.map(b => b.page_url) || [])
      existingPages = new Set([...existingPages, ...briefPages])
    }

    const newDrops = significantDrops
      .filter(d => !existingPages.has(d.page))
      .sort((a, b) => b.clicks_drop - a.clicks_drop)  // worst drops first
      .slice(0, maxDropsPerDay)                        // cap per config

    // 5. Queue agent_actions
    let actionsQueued = 0

    for (const drop of newDrops) {
      const priority = drop.clicks_drop > 20 ? 'high' : 'medium'

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key: 'pak-rt',
          run_id: runId,
          site_slug: siteSlug,
          action_type: 'add_action_item',
          title: `"${drop.page}" dropped ${drop.clicks_drop.toFixed(0)} clicks (-${drop.clicks_drop_pct.toFixed(1)}%)`,
          description: `Page dropped from position ${drop.position_change > 0 ? '+' : ''}${drop.position_change.toFixed(1)}. Previous clicks: ${drop.clicks_prev}, Current: ${drop.clicks_now}. Recommend on-page review.`,
          priority,
          data: {
            page: drop.page,
            site_url: siteUrl,
            clicks_drop: drop.clicks_drop,
            clicks_drop_pct: drop.clicks_drop_pct,
            position_change: drop.position_change,
            action_type: 'on_page',
          },
        })

      if (!insertErr) actionsQueued++
    }

    const cappedNote = significantDrops.length - existingPages.size > maxDropsPerDay
      ? ` (capped at ${maxDropsPerDay}/day)`
      : ''
    const summary = `Found ${significantDrops.length} drops. Filtered ${existingPages.size} already in progress. Queued ${actionsQueued} new actions${cappedNote}.`

    // Update run record
    await db
      .from('agent_runs')
      .update({
        status: 'success',
        summary,
        findings_count: significantDrops.length,
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
      .eq('agent_key', 'pak-rt')

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
      .eq('agent_key', 'pak-rt')

    throw err
  }
}
