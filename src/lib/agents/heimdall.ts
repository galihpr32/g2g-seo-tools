import { createServiceClient } from '@/lib/supabase/service'
import { normalizeUrl } from '@/lib/agents/site-helpers'

/**
 * Heimdall (Watchdog) — detects ranking drops and queues action items.
 *
 * IMPORTANT — schema note:
 * gsc_ranking_drops is a PRE-AGGREGATED comparison table. Each row already
 * contains a complete week-over-week comparison: clicks_now, clicks_prev,
 * clicks_drop (numeric fraction 0-1, e.g. 0.23 = 23% drop), position_now,
 * position_prev, position_diff. The upstream gsc-daily cron computes these
 * by comparing GSC API responses across days.
 *
 * The previous version of Heimdall (incl. our first rewrite) tried to bucket
 * raw daily snapshots into "previous week" vs "this week" — that was wrong
 * for this schema. We don't need to bucket anything; just take the freshest
 * row per page and read the comparison fields directly.
 *
 * Logic:
 * 1. Get GSC connection + site_url
 * 2. Pull the most recent 14 days of gsc_ranking_drops rows
 * 3. Per page, keep the most recent snapshot
 * 4. Filter by clicks_drop_abs > minClicksDrop AND clicks_drop_pct > minPctDrop
 * 5. Dedup against pending action_items + existing briefs (URL-normalized)
 * 6. Queue agent_actions; high-severity drops get fast-pathed to Bragi
 */
export interface HeimdallConfig {
  maxDropsPerDay: number      // max URLs to queue per run (default: 10)
  minClicksDrop:  number      // minimum absolute click drop (default: 5)
  minPctDrop:     number      // minimum % drop, e.g. 20 = 20% (default: 20)
  fastPathEnabled?: boolean   // default true — enable run_agent handoff for critical drops
}

export const HEIMDALL_DEFAULTS: HeimdallConfig = {
  maxDropsPerDay:  10,
  minClicksDrop:   5,
  minPctDrop:      20,
  fastPathEnabled: true,
}

interface DropRow {
  page:           string
  snapshot_date:  string
  clicks_now:     number | null
  clicks_prev:    number | null
  clicks_drop:    number | null   // fraction 0-1
  position_now:   number | null
  position_prev:  number | null
  position_diff:  number | null
}

export async function runHeimdall(
  ownerId: string,
  siteSlug: string,
  runId: string,
  config: Partial<HeimdallConfig> = {}
): Promise<{
  summary: string
  actionsQueued: number
}> {
  const { maxDropsPerDay, minClicksDrop, minPctDrop, fastPathEnabled } =
    { ...HEIMDALL_DEFAULTS, ...config }
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    // 0. Trigger GSC sync to refresh upstream comparison
    try {
      const appUrl     = process.env.NEXT_PUBLIC_APP_URL
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

    // 1. GSC connection
    const { data: conn, error: connErr } = await db
      .from('gsc_connections')
      .select('site_url')
      .eq('user_id', ownerId)
      .maybeSingle()

    if (connErr) throw new Error(`GSC connection lookup failed: ${connErr.message}`)
    if (!conn?.site_url) throw new Error('No GSC connection found — connect GSC in Settings before running Heimdall')

    const siteUrl = conn.site_url

    // 2. Pull last 14 days of pre-aggregated drops, ordered DESC so the
    //    first row per page is the freshest.
    const fourteenDaysAgoIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)

    const { data: drops, error: dropsErr } = await db
      .from('gsc_ranking_drops')
      .select('page, snapshot_date, clicks_now, clicks_prev, clicks_drop, position_now, position_prev, position_diff')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', fourteenDaysAgoIso)
      .order('snapshot_date', { ascending: false })

    if (dropsErr) throw new Error(`gsc_ranking_drops query failed: ${dropsErr.message}`)
    if (!drops?.length) {
      const summary = warnings.length
        ? `No ranking data to analyze. ${warnings.join('; ')}`
        : 'No ranking data to analyze. Run a GSC sync first.'
      await _finishRun(db, runId, ownerId, warnings.length ? 'partial' : 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    // 3. Take the freshest row per page (drops is already DESC by date)
    const latestByPage = new Map<string, DropRow>()
    const originalByNorm = new Map<string, string>()
    for (const d of drops as DropRow[]) {
      if (!d.page) continue
      const norm = normalizeUrl(d.page)
      if (!norm) continue
      if (!latestByPage.has(norm)) {
        latestByPage.set(norm, d)
        originalByNorm.set(norm, d.page)
      }
    }

    interface SignificantDrop {
      page:            string   // normalized
      original_page:   string
      clicks_prev:     number
      clicks_now:      number
      clicks_drop_abs: number
      clicks_drop_pct: number   // e.g. 23 for 23%
      position_prev:   number
      position_now:    number
      position_diff:   number   // positive = got worse
      snapshot_date:   string
    }

    // 4. Filter to significant drops
    const significantDrops: SignificantDrop[] = []
    for (const [page, row] of latestByPage.entries()) {
      const clicksPrev = row.clicks_prev ?? 0
      const clicksNow  = row.clicks_now  ?? 0
      const clicksDropAbs = clicksPrev - clicksNow
      // clicks_drop is stored as fraction (0-1). Convert to percent.
      const clicksDropPct = (row.clicks_drop ?? 0) * 100

      if (clicksDropAbs > minClicksDrop && clicksDropPct > minPctDrop) {
        significantDrops.push({
          page,
          original_page:   originalByNorm.get(page) ?? row.page,
          clicks_prev:     clicksPrev,
          clicks_now:      clicksNow,
          clicks_drop_abs: clicksDropAbs,
          clicks_drop_pct: clicksDropPct,
          position_prev:   row.position_prev ?? 0,
          position_now:    row.position_now  ?? 0,
          position_diff:   row.position_diff ?? 0,
          snapshot_date:   row.snapshot_date,
        })
      }
    }

    // 5. Dedup against pending action_items + existing briefs
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
      .sort((a, b) => b.clicks_drop_pct - a.clicks_drop_pct)
      .slice(0, maxDropsPerDay)

    // 6. Queue actions. Critical drops fast-path to Bragi via run_agent.
    let actionsQueued = 0
    let queueErrors   = 0

    for (const drop of newDrops) {
      const priority = drop.clicks_drop_abs > 20 || drop.clicks_drop_pct > 50 ? 'high' : 'medium'
      const isCritical = !!fastPathEnabled && drop.clicks_drop_pct > 50 && drop.clicks_prev >= 100

      const posChangeStr = drop.position_diff > 0
        ? `slipped ${drop.position_diff.toFixed(1)} positions (${drop.position_prev.toFixed(1)} → ${drop.position_now.toFixed(1)})`
        : drop.position_diff < 0
          ? `improved ${Math.abs(drop.position_diff).toFixed(1)} positions but clicks still down`
          : `held position at ${drop.position_now.toFixed(1)}`

      const description = [
        `Clicks down ${drop.clicks_drop_abs} (-${drop.clicks_drop_pct.toFixed(1)}%): ${drop.clicks_prev} → ${drop.clicks_now} (snapshot ${drop.snapshot_date}).`,
        `Position: ${posChangeStr}.`,
        isCritical
          ? `⚡ Critical drop — approve to auto-draft a brief via Bragi.`
          : `Recommend on-page review (intent match, freshness, internal links, schema).`,
      ].join(' ')

      const sharedData = {
        page:             drop.original_page,
        site_url:         siteUrl,
        clicks_prev:      drop.clicks_prev,
        clicks_now:       drop.clicks_now,
        clicks_drop:      drop.clicks_drop_abs,
        clicks_drop_pct:  drop.clicks_drop_pct,
        position_prev:    drop.position_prev,
        position_now:     drop.position_now,
        position_diff:    drop.position_diff,
        snapshot_date:    drop.snapshot_date,
      }

      let insertErr
      if (isCritical) {
        ;({ error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'heimdall',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'run_agent',
            title:         `⚡ Critical drop: "${drop.original_page}" -${drop.clicks_drop_pct.toFixed(0)}% — draft brief?`,
            description,
            priority:      'high',
            data: {
              handoff_to: 'bragi',
              context:    'heimdall_critical_drop',
              payload: {
                keyword:         drop.original_page.split('/').pop()?.replace(/-/g, ' ') ?? drop.original_page,
                page_url:        drop.original_page,
                source_agent:    'heimdall',
                brief_type:      'on_page',
                context:         `Critical ranking drop: ${description}`,
                position_change: drop.position_diff,
              },
              ...sharedData,
              fast_path: true,
            },
          }))
      } else {
        ;({ error: insertErr } = await db
          .from('agent_actions')
          .insert({
            owner_user_id: ownerId,
            agent_key:     'heimdall',
            run_id:        runId,
            site_slug:     siteSlug,
            action_type:   'add_action_item',
            title:         `"${drop.original_page}" dropped ${drop.clicks_drop_abs} clicks (-${drop.clicks_drop_pct.toFixed(1)}%)`,
            description,
            priority,
            data: {
              ...sharedData,
              position_change: drop.position_diff,   // legacy alias for executor
              action_type:     'on_page',
            },
          }))
      }

      if (insertErr) {
        queueErrors++
        console.error('[heimdall] agent_actions insert failed:', insertErr.message, { page: drop.original_page })
      } else {
        actionsQueued++
      }
    }

    if (queueErrors > 0) warnings.push(`${queueErrors} action insert(s) failed`)

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
