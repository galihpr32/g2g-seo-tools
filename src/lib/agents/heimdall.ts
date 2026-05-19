import { createServiceClient } from '@/lib/supabase/service'
import { normalizeUrl } from '@/lib/agents/site-helpers'
import { lookupKeywordInUniverse } from '@/lib/agents/universe-helpers'
import { persistFindingsBulk, type HeimdallDropAnalysisData } from '@/lib/agents/findings'

/**
 * Classify a ranking drop into a likely root-cause category and return a
 * structured fix checklist, using only signals from gsc_ranking_drops.
 *
 * The output is heuristic — meant to give the user a prioritised starting
 * hypothesis, not a verdict. Fix checklist steps are ordered by urgency.
 *
 * Categories (technical-SEO + SEO-audit methodology):
 *   algorithmic → big position slide; likely SERP layout shift, backlink
 *                 decay, or topical authority loss. Longest to recover.
 *   technical   → position held but clicks tanked; CTR / impression loss.
 *                 Often fastest to fix: indexation, schema, snippet.
 *   content     → moderate position + sharp click loss; intent mismatch
 *                 or stale content. Weeks to recover with a refresh.
 *   unknown     → mixed signals; run full-spectrum checks.
 *
 * recovery_potential:
 *   high   = technical (snippet/schema fix is same-day)
 *   medium = content (refresh takes days to weeks to register)
 *   low    = algorithmic (link profile / authority takes months)
 */
type FixStep = { step: string; priority: 'immediate' | 'high' | 'medium' }

function categorizeDrop(args: {
  clicksDropPct: number
  positionDiff:  number    // positive = slipped down
  clicksPrev:    number
}): {
  category:           HeimdallDropAnalysisData['category']
  reasoning:          string
  recommendation:     string
  fix_checklist:      FixStep[]
  recovery_potential: 'high' | 'medium' | 'low'
} {
  const { clicksDropPct, positionDiff } = args

  if (positionDiff >= 5) {
    return {
      category:    'algorithmic',
      reasoning:   `Slipped ${positionDiff.toFixed(1)} positions — likely SERP/algorithm shift or backlink decay. Position drop is the dominant signal here.`,
      recommendation: 'Audit recent backlinks (lost/toxic), check for SERP layout changes (AI overviews, new feature snippets), review competitors who gained positions.',
      recovery_potential: 'low',
      fix_checklist: [
        { step: 'Compare SERP top-3 now vs 2 weeks ago — check for new AI Overviews or featured snippets displacing organic', priority: 'immediate' },
        { step: 'Audit lost/toxic backlinks via GSC Links report and Ahrefs/SEMrush lost links filter', priority: 'immediate' },
        { step: 'Review competitors who gained positions for E-E-A-T signals (author bios, cite dates, depth)', priority: 'high' },
        { step: 'Add fresh internal links from recently published pages to boost topical authority signal', priority: 'medium' },
      ],
    }
  }

  if (Math.abs(positionDiff) < 1 && clicksDropPct >= 30) {
    return {
      category:    'technical',
      reasoning:   `Position held (${positionDiff >= 0 ? '+' : ''}${positionDiff.toFixed(1)}) but clicks fell ${clicksDropPct.toFixed(0)}% — CTR or impression loss, not a ranking loss. Likely indexation, snippet, or schema issue.`,
      recommendation: 'Check GSC indexation, verify schema/structured data, review snippet (title/meta) for staleness, confirm canonical and robots.txt unchanged.',
      recovery_potential: 'high',
      fix_checklist: [
        { step: 'Verify page is indexed: search site:PAGE_URL in Google + check GSC Coverage report for errors', priority: 'immediate' },
        { step: 'Validate structured data with Schema.org validator — broken schema removes rich snippets and tanks CTR', priority: 'immediate' },
        { step: 'Rewrite title tag & meta description to match current SERP intent — A/B test against competitors\' snippets', priority: 'high' },
        { step: 'Confirm canonical tag is self-referential and robots.txt has no new disallow rules', priority: 'high' },
        { step: 'Run Core Web Vitals (PageSpeed Insights) — CWV demotion can suppress impressions even with stable rank', priority: 'medium' },
      ],
    }
  }

  if (positionDiff >= 2 && positionDiff < 5 && clicksDropPct >= 25) {
    return {
      category:    'content',
      reasoning:   `Moderate position slip (${positionDiff.toFixed(1)}) combined with ${clicksDropPct.toFixed(0)}% click drop — content likely misaligned with current search intent or has gone stale.`,
      recommendation: 'Review on-page content for freshness and intent match against current SERP top-3, refresh internal links and meta description, cover new sub-intents.',
      recovery_potential: 'medium',
      fix_checklist: [
        { step: 'Check SERP top-3 intent vs page H1/intro — intent mismatch (informational vs transactional) is the #1 cause', priority: 'immediate' },
        { step: 'Refresh stale info: update prices, availability, dates, and any facts that have changed since last publish', priority: 'high' },
        { step: 'Identify new sub-intents in the SERP (e.g. "how to sell" vs just "buy") — add a section if missing', priority: 'high' },
        { step: 'Add internal links from recently published pages using on-topic anchor text', priority: 'medium' },
      ],
    }
  }

  return {
    category:    'unknown',
    reasoning:   `Mixed signals — clicks down ${clicksDropPct.toFixed(0)}%, position diff ${positionDiff.toFixed(1)}. Likely a combination of factors.`,
    recommendation: 'Run full audit: indexation, on-page freshness, backlink profile, SERP layout, internal links.',
    recovery_potential: 'medium',
    fix_checklist: [
      { step: 'Run site:PAGE_URL — confirm the page is indexed and not duplicated', priority: 'immediate' },
      { step: 'Open GSC Performance for this URL — identify which queries declined most and by how much', priority: 'immediate' },
      { step: 'Audit on-page content freshness and SERP intent match against current top-3', priority: 'high' },
      { step: 'Review backlink profile for any losses in the past 30 days', priority: 'medium' },
    ],
  }
}

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
  // URL scope filters
  urlMustInclude?: string[]   // whitelist — page URL must contain at least one (default: ['/categories/'])
  urlMustExclude?: string[]   // blacklist — page URL must not contain any (default: ['/offer/'])
  filterRegionCodes?: boolean // strip pages with 2-letter country-code path segments like /sg/, /my/ (default: true)
}

export const HEIMDALL_DEFAULTS: HeimdallConfig = {
  maxDropsPerDay:    10,
  minClicksDrop:     5,
  minPctDrop:        20,
  fastPathEnabled:   true,
  urlMustInclude:    ['/categories/'],
  urlMustExclude:    ['/offer/'],
  filterRegionCodes: true,
}

// Region-code path-segment regex: matches /sg/, /my/, /us/, /ph/, etc.
const REGION_CODE_RE = /\/[a-z]{2}\//i

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
  const {
    maxDropsPerDay, minClicksDrop, minPctDrop, fastPathEnabled,
    urlMustInclude   = HEIMDALL_DEFAULTS.urlMustInclude!,
    urlMustExclude   = HEIMDALL_DEFAULTS.urlMustExclude!,
    filterRegionCodes = HEIMDALL_DEFAULTS.filterRegionCodes,
  } = { ...HEIMDALL_DEFAULTS, ...config }

  // Build URL scope checker (applied per page before threshold filtering)
  const isInScope = (url: string): boolean => {
    if (urlMustInclude.length > 0 && !urlMustInclude.some(p => url.includes(p))) return false
    if (urlMustExclude.length > 0 &&  urlMustExclude.some(p => url.includes(p))) return false
    if (filterRegionCodes && REGION_CODE_RE.test(url)) return false
    return true
  }
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    // 0. Best-effort GSC sync — hard-capped at 4 s so Heimdall stays within
    //    Vercel Hobby's 10 s function limit. The gsc-daily cron runs at 1am UTC
    //    and keeps data fresh; manual triggers just use whatever is cached.
    try {
      const appUrl     = process.env.NEXT_PUBLIC_APP_URL
      const cronSecret = process.env.CRON_SECRET
      if (appUrl && cronSecret) {
        const controller = new AbortController()
        const syncTimer  = setTimeout(() => controller.abort(), 4_000)
        console.log('[heimdall] Attempting quick GSC sync (4 s cap)…')
        const syncRes = await fetch(`${appUrl}/api/cron/gsc-daily`, {
          headers: { Authorization: `Bearer ${cronSecret}` },
          signal:  controller.signal,
        }).finally(() => clearTimeout(syncTimer))
        if (!syncRes.ok) {
          warnings.push(`GSC sync returned ${syncRes.status} — using cached data`)
        } else {
          console.log('[heimdall] GSC sync completed within deadline.')
        }
      }
    } catch (syncErr) {
      const msg = syncErr instanceof Error ? syncErr.message : String(syncErr)
      // AbortError is expected on cap; log others
      if ((syncErr as Error).name !== 'AbortError') {
        console.warn('[heimdall] GSC sync failed:', syncErr)
      }
      warnings.push(`GSC sync skipped: ${msg} — using cached data`)
    }

    // 1. Resolve site_url for the active brand from site_configs (Sprint 12).
    // Heimdall already receives `siteSlug` as a function arg — use it.
    const { data: brandSiteConfig, error: cfgErr } = await db
      .from('site_configs')
      .select('gsc_property')
      .eq('slug', siteSlug)
      .eq('is_active', true)
      .maybeSingle()

    if (cfgErr) throw new Error(`site_configs lookup failed: ${cfgErr.message}`)
    if (!brandSiteConfig?.gsc_property) throw new Error(`No active site_config for slug=${siteSlug}`)

    // Verify GSC OAuth is connected (tokens cover all properties under the same Google account)
    const { data: conn } = await db
      .from('gsc_connections')
      .select('user_id')
      .eq('user_id', ownerId)
      .maybeSingle()
    if (!conn) throw new Error('No GSC connection found — connect GSC in Settings before running Heimdall')

    const siteUrl = brandSiteConfig.gsc_property

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

    // 3. Take the freshest row per page (drops is already DESC by date).
    //    Apply URL scope filter here — before any heavy processing.
    const latestByPage = new Map<string, DropRow>()
    const originalByNorm = new Map<string, string>()
    let filteredOutCount = 0
    for (const d of drops as DropRow[]) {
      if (!d.page) continue
      if (!isInScope(d.page)) { filteredOutCount++; continue }
      const norm = normalizeUrl(d.page)
      if (!norm) continue
      if (!latestByPage.has(norm)) {
        latestByPage.set(norm, d)
        originalByNorm.set(norm, d.page)
      }
    }
    if (filteredOutCount > 0) {
      console.log(`[heimdall] Skipped ${filteredOutCount} out-of-scope pages (offer/region/non-categories)`)
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

    // 4b. Persist drop_analysis findings for EVERY significant drop —
    //     including ones that get deduped or capped below. This is what
    //     powers the /gsc/ranking-drop page enrichment so users see
    //     Heimdall's verdict on all drops, not just queued ones.
    if (significantDrops.length > 0) {
      // Fetch top dropped queries per page (best-effort — non-blocking).
      // gsc_ranking_drop_queries is keyed by (site_url, snapshot_date, page).
      const pagesForQueries = significantDrops.map(d => d.original_page)
      const { data: queriesRows } = await db
        .from('gsc_ranking_drop_queries')
        .select('page, query, clicks, position')
        .eq('site_url', siteUrl)
        .in('page', pagesForQueries)
        .order('clicks', { ascending: false })

      const queriesByPage = new Map<string, { query: string; clicks_drop: number }[]>()
      for (const q of queriesRows ?? []) {
        const arr = queriesByPage.get(q.page) ?? []
        if (arr.length < 5) {
          arr.push({ query: String(q.query), clicks_drop: Number(q.clicks ?? 0) })
          queriesByPage.set(q.page, arr)
        }
      }

      const findingPayloads = significantDrops.map(d => {
        const verdict = categorizeDrop({
          clicksDropPct: d.clicks_drop_pct,
          positionDiff:  d.position_diff,
          clicksPrev:    d.clicks_prev,
        })
        const data: HeimdallDropAnalysisData = {
          page:                d.original_page,
          clicks_drop:         d.clicks_drop_abs,
          pct_drop:            d.clicks_drop_pct,
          position_diff:       d.position_diff,
          category:            verdict.category,
          reasoning:           verdict.reasoning,
          recommendation:      verdict.recommendation,
          top_dropped_queries: queriesByPage.get(d.original_page) ?? [],
          fix_checklist:       verdict.fix_checklist,
          recovery_potential:  verdict.recovery_potential,
        }
        const severity: 'high' | 'medium' | 'low' =
          d.clicks_drop_pct >= 50 || d.clicks_drop_abs >= 50 ? 'high'
          : d.clicks_drop_pct >= 30                          ? 'medium' : 'low'
        return {
          agentKey:    'heimdall',
          ownerId,
          runId,
          siteSlug,
          findingType: 'drop_analysis',
          subject:     d.original_page,
          severity,
          data:        data as unknown as Record<string, unknown>,
        }
      })
      await persistFindingsBulk(db, findingPayloads)
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

      // Classify drop here (verdict also feeds action description below).
      // Note: findings bulk-persist above already computed verdicts for all drops;
      // we recompute here per-action because the findings loop runs before dedup.
      const actionVerdict = categorizeDrop({
        clicksDropPct: drop.clicks_drop_pct,
        positionDiff:  drop.position_diff,
        clicksPrev:    drop.clicks_prev,
      })
      const topFix = actionVerdict.fix_checklist[0]?.step ?? actionVerdict.recommendation

      const description = [
        `Clicks down ${drop.clicks_drop_abs} (-${drop.clicks_drop_pct.toFixed(1)}%): ${drop.clicks_prev} → ${drop.clicks_now} (snapshot ${drop.snapshot_date}).`,
        `Position: ${posChangeStr}.`,
        `Root cause: ${actionVerdict.category} — ${actionVerdict.reasoning}`,
        `#1 fix: ${topFix}`,
        isCritical
          ? `⚡ Critical drop — approve to auto-draft a brief via Bragi.`
          : ``,
      ].filter(Boolean).join(' ')

      // Derive keyword candidate from URL path for universe lookup.
      // /categories/wow-gold → "wow gold"
      const keywordGuess = drop.original_page.split('/').pop()?.replace(/-/g, ' ') ?? drop.original_page
      const universe = await lookupKeywordInUniverse(db, ownerId, keywordGuess)

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
        keyword_map_cluster_id: universe.keyword_map_cluster_id,
        keyword_map_id:         universe.keyword_map_id,
        topic:                  universe.topic,
        outside_universe:       universe.outside_universe,
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
    const scopeNote = filteredOutCount > 0 ? ` Skipped ${filteredOutCount} out-of-scope pages (offer/region/non-categories).` : ''
    const summaryBase = `Found ${significantDrops.length} drops.${scopeNote} Filtered ${existingPagesNorm.size} already in progress. Queued ${actionsQueued} new actions${cappedNote}.`
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
