import { createServiceClient } from '@/lib/supabase/service'
import { normalizeUrl } from '@/lib/agents/site-helpers'

/**
 * Heimdall (Watchdog) — detects ranking drops and queues action items.
 *
 * Logic:
 * 1. Get GSC connection + site_url
 * 2. Fetch last 14 days of GSC ranking drops, then split into two 7-day buckets
 *    BY DATE (not by row count — previous version used array midpoint which
 *    broke when snapshots were uneven across days)
 * 3. Find pages where clicks dropped > minClicksDrop AND clicks_drop% > minPctDrop
 * 4. Filter out pages already in progress or with existing briefs (URLs are
 *    normalized so seo_action_items.page and seo_content_briefs.page match
 *    even if one stores absolute and the other relative URLs)
 * 5. Queue agent_actions for remaining pages
 */
export interface HeimdallConfig {
  maxDropsPerDay: number      // max URLs to queue per run (default: 10)
  minClicksDrop: number       // minimum absolute click drop to consider (default: 5)
  minPctDrop: number          // minimum % drop to consider (default: 20)
}

export const HEIMDALL_DEFAULTS: HeimdallConfig = {
  maxDropsPerDay: 10,
  minClicksDrop: 5,
  minPctDrop: 20,
}

interface PageWindow {
  clicks_total: number
  pos_sum:      number   // for averaging
  pos_count:    number
  pos_best:     number   // min position seen (lower = better)
  pos_worst:    number   // max position seen
}

const newWindow = (): PageWindow => ({
  clicks_total: 0,
  pos_sum:      0,
  pos_count:    0,
  pos_best:     999,
  pos_worst:    0,
})

function pushSample(w: PageWindow, clicks: number, position: number) {
  w.clicks_total += clicks
  if (position > 0) {
    w.pos_sum   += position
    w.pos_count += 1
    if (position < w.pos_best)  w.pos_best  = position
    if (position > w.pos_worst) w.pos_worst = position
  }
}

const avgPos = (w: PageWindow): number =>
  w.pos_count > 0 ? w.pos_sum / w.pos_count : 0

export async function runHeimdall(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<HeimdallConfig> = {}
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const { maxDropsPerDay, minClicksDrop, minPctDrop } = { ...HEIMDALL_DEFAULTS, ...config }
  const db = createServiceClient()

  // Track partial-failure state: a run can succeed-with-warning if GSC sync
  // failed but cached data was usable.
  const warnings: string[] = []

  try {
    // 0. Trigger GSC sync to get fresh data before analyzing
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL
      const cronSecret = process.env.CRON_SECRET
      if (appUrl && cronSecret) {
        console.log('[heimdall] Triggering GSC sync before analysis…')
        const syncRes = await fetch(`${appUrl}/api/cron/gsc-daily`, {
          headers: { Authorization: `Bearer ${cronSecret}` },
        })
        if (!syncRes.ok) {
          warnings.push(`GSC sync returned ${syncRes.status} (used cached data)`)
        } else {
          console.log('[heimdall] GSC sync completed.')
        }
      }
    } catch (syncErr) {
      const msg = syncErr instanceof Error ? syncErr.message : String(syncErr)
      warnings.push(`GSC sync failed: ${msg} (used cached data)`)
      console.warn('[heimdall] GSC sync failed:', syncErr)
    }

    // 1. Get GSC connection
    const { data: conn, error: connErr } = await db
      .from('gsc_connections')
      .select('site_url')
      .eq('user_id', ownerId)
      .maybeSingle()

    if (connErr) throw new Error(`GSC connection lookup failed: ${connErr.message}`)
    if (!conn?.site_url) throw new Error('No GSC connection found — connect GSC in Settings before running Heimdall')

    const siteUrl = conn.site_url

    // 2. Fetch ranking drops from last 14 days, ordered ASC for windowing
    const today  = new Date()
    const sevenDaysAgoIso  = new Date(today.getTime() -  7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const fourteenDaysAgoIso = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const { data: drops, error: dropsErr } = await db
      .from('gsc_ranking_drops')
      .select('page, clicks_now, position, snapshot_date')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', fourteenDaysAgoIso)
      .order('snapshot_date', { ascending: true })

    if (dropsErr) throw new Error(`gsc_ranking_drops query failed: ${dropsErr.message}`)
    if (!drops?.length) {
      const summary = warnings.length
        ? `No ranking data to analyze. ${warnings.join('; ')}`
        : 'No ranking data to analyze. Run a GSC sync first.'
      await _finishRun(db, runId, ownerId, warnings.length ? 'partial' : 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    // 3. Split snapshots by DATE (not row count). Anything strictly before the
    //    7-day cutoff is "previous week", anything on/after is "current week".
    const prevByPage = new Map<string, PageWindow>()
    const nowByPage  = new Map<string, PageWindow>()

    for (const d of drops) {
      const page = normalizeUrl(d.page)
      if (!page) continue
      const bucket = (d.snapshot_date as string) < sevenDaysAgoIso ? prevByPage : nowByPage
      const w = bucket.get(page) ?? newWindow()
      pushSample(w, d.clicks_now ?? 0, d.position ?? 0)
      bucket.set(page, w)
    }

    interface Drop {
      page:            string
      original_page:   string  // un-normalized for display
      clicks_prev:     number
      clicks_now:      number
      clicks_drop:     number
      clicks_drop_pct: number
      pos_prev_avg:    number
      pos_now_avg:     number
      position_change: number
      pos_best_now:    number
      pos_worst_now:   number
    }

    // Map normalized → original for display; keep first-seen original
    const originalByNormalized = new Map<string, string>()
    for (const d of drops) {
      const norm = normalizeUrl(d.page)
      if (norm && !originalByNormalized.has(norm)) {
        originalByNormalized.set(norm, String(d.page))
      }
    }

    const significantDrops: Drop[] = []
    // Only consider pages that appear in BOTH windows (otherwise we can't
    // compare). Pages that only appeared this week are "new ranking" not "drop".
    for (const [page, prev] of prevByPage.entries()) {
      const now = nowByPage.get(page)
      if (!now) continue

      const clicksDrop    = prev.clicks_total - now.clicks_total
      const clicksDropPct = prev.clicks_total > 0
        ? (clicksDrop / prev.clicks_total) * 100
        : 0

      if (clicksDrop > minClicksDrop && clicksDropPct > minPctDrop) {
        const prevPosAvg = avgPos(prev)
        const nowPosAvg  = avgPos(now)
        significantDrops.push({
          page,
          original_page:   originalByNormalized.get(page) ?? page,
          clicks_prev:     prev.clicks_total,
          clicks_now:      now.clicks_total,
          clicks_drop:     clicksDrop,
          clicks_drop_pct: clicksDropPct,
          pos_prev_avg:    prevPosAvg,
          pos_now_avg:     nowPosAvg,
          // position_change: positive = got worse (higher position number)
          position_change: prevPosAvg > 0 && nowPosAvg > 0 ? nowPosAvg - prevPosAvg : 0,
          pos_best_now:    now.pos_best,
          pos_worst_now:   now.pos_worst,
        })
      }
    }

    // 4. Filter out pages already in progress (with normalized URLs)
    const pagesToCheck = significantDrops.map(d => d.original_page)
    let existingPagesNorm = new Set<string>()

    if (pagesToCheck.length > 0) {
      const { data: existing } = await db
        .from('seo_action_items')
        .select('page')
        .eq('site_url', siteUrl)
        .in('page', pagesToCheck)
        .in('status', ['pending', 'in_progress'])

      const { data: briefs } = await db
        .from('seo_content_briefs')
        .select('page')
        .eq('site_url', siteUrl)
        .in('page', pagesToCheck)

      existingPagesNorm = new Set([
        ...(existing?.map(e => normalizeUrl(e.page)) ?? []),
        ...(briefs?.map(b => normalizeUrl(b.page)) ?? []),
      ])
    }

    const newDrops = significantDrops
      .filter(d => !existingPagesNorm.has(d.page))
      .sort((a, b) => b.clicks_drop_pct - a.clicks_drop_pct)  // worst % drops first
      .slice(0, maxDropsPerDay)

    // 5. Queue agent_actions
    let actionsQueued = 0
    let queueErrors   = 0

    for (const drop of newDrops) {
      const priority = drop.clicks_drop > 20 || drop.clicks_drop_pct > 50 ? 'high' : 'medium'
      const posChangeStr = drop.position_change > 0
        ? `slipped ${drop.position_change.toFixed(1)} positions (avg ${drop.pos_prev_avg.toFixed(1)} → ${drop.pos_now_avg.toFixed(1)})`
        : drop.position_change < 0
          ? `improved ${Math.abs(drop.position_change).toFixed(1)} positions but clicks still down`
          : `held position (avg ${drop.pos_now_avg.toFixed(1)})`

      const description = [
        `Clicks down ${drop.clicks_drop.toFixed(0)} (-${drop.clicks_drop_pct.toFixed(1)}%): ${drop.clicks_prev} → ${drop.clicks_now} over the last 7 days vs prior 7.`,
        `Position: ${posChangeStr}.`,
        `Recommend on-page review (intent match, freshness, internal links, schema).`,
      ].join(' ')

      const { error: insertErr } = await db
        .from('agent_actions')
        .insert({
          owner_user_id: ownerId,
          agent_key: 'heimdall',
          run_id: runId,
          site_slug: siteSlug,
          action_type: 'add_action_item',
          title: `"${drop.original_page}" dropped ${drop.clicks_drop.toFixed(0)} clicks (-${drop.clicks_drop_pct.toFixed(1)}%)`,
          description,
          priority,
          data: {
            page:             drop.original_page,
            site_url:         siteUrl,
            clicks_prev:      drop.clicks_prev,
            clicks_now:       drop.clicks_now,
            clicks_drop:      drop.clicks_drop,
            clicks_drop_pct:  drop.clicks_drop_pct,
            position_change:  drop.position_change,
            pos_prev_avg:     drop.pos_prev_avg,
            pos_now_avg:      drop.pos_now_avg,
            pos_best_now:     drop.pos_best_now,
            pos_worst_now:    drop.pos_worst_now,
            action_type:      'on_page',
          },
        })

      if (insertErr) {
        queueErrors++
        console.error('[heimdall] agent_actions insert failed:', insertErr.message, { page: drop.original_page })
      } else {
        actionsQueued++
      }
    }

    if (queueErrors > 0) warnings.push(`${queueErrors} action insert(s) failed (see server logs)`)

    const cappedNote = significantDrops.length - existingPagesNorm.size > maxDropsPerDay
      ? ` (capped at ${maxDropsPerDay}/day)`
      : ''
    const summaryBase = `Found ${significantDrops.length} drops. Filtered ${existingPagesNorm.size} already in progress. Queued ${actionsQueued} new actions${cappedNote}.`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase

    const status = warnings.length > 0 ? 'partial' : 'success'
    await _finishRun(db, runId, ownerId, status, summary, significantDrops.length, actionsQueued, warnings)

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
    .eq('agent_key', 'heimdall')
}
