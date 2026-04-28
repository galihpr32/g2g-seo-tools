import { createServiceClient } from '@/lib/supabase/service'
import { getDomainRankedKeywords } from '@/lib/dataforseo/client'
import { getSiteUrlForSlug } from '@/lib/agents/site-helpers'
import { lookupKeywordInUniverse } from '@/lib/agents/universe-helpers'
import { logApiUsage } from '@/lib/api-logger'
import {
  persistFindingsBulk,
  persistFinding,
  type LokiKeywordGapData,
  type LokiSovSnapshotData,
  type LokiCompetitorSummaryData,
} from '@/lib/agents/findings'

/**
 * Loki — Competitive Analysis Agent
 *
 * Logic:
 * 1. Get active competitor list from DB
 * 2. Keyword gap analysis via DataForSEO: keywords competitors rank top-10 but G2G doesn't
 * 3. SOV delta via serp_snapshots: compare G2G top-10 share vs 30 days ago (relative %)
 * 4. Queue agent_actions for findings (max 10 per run)
 *
 * Failure model: external API (DataForSEO) errors are no longer silent.
 * If gap analysis fails entirely, the run completes with status='partial'
 * and the error is recorded — not "success with 0 findings".
 */

// ── Language filter ─────────────────────────────────────────────────────────
// DataForSEO with language_code='en' still occasionally returns non-English
// keywords for competitors that rank internationally. Reject them here.
const NON_ENGLISH_MARKERS = new Set([
  // Spanish / Portuguese
  'compra','comprar','venta','vender','precio','gratis','barato','monedas',
  'como','para','con','del','una','este','esto','eso','los','las','por','que',
  // French
  'acheter','vendre','achats','prix','gratuit',
  // German
  'kaufen','verkaufen','günstig','kostenlos',
  // Italian
  'comprare','vendere','gratuito',
])

function isEnglishKeyword(kw: string): boolean {
  // Reject any keyword with non-ASCII / accented characters
  if (/[^\x00-\x7F]/.test(kw)) return false
  // Reject if any token is a known non-English marker
  const tokens = kw.toLowerCase().split(/\s+/)
  return !tokens.some(t => NON_ENGLISH_MARKERS.has(t))
}

// ── Near-duplicate detection ────────────────────────────────────────────────
// "fortnite tracker" and "fortnite tracker 4" share all tokens of the shorter
// keyword — treat the longer one as a near-duplicate and skip it.
// Rule: if the token set of A is a subset of token set of B (or vice versa)
//       they are near-duplicates. Keep the one already queued.
function isNearDuplicate(candidate: string, existingKeywords: Set<string>): boolean {
  const cTokens = candidate.toLowerCase().split(/\s+/).filter(Boolean)
  const cSet    = new Set(cTokens)
  for (const queued of existingKeywords) {
    const qSet = new Set(queued.toLowerCase().split(/\s+/).filter(Boolean))
    // candidate is a superset of an already-queued kw ("fortnite tracker 4" ⊃ "fortnite tracker")
    const candidateIsSuperSet = [...qSet].every(t => cSet.has(t))
    // candidate is a subset of an already-queued kw
    const candidateIsSubSet   = [...cSet].every(t => qSet.has(t))
    if (candidateIsSuperSet || candidateIsSubSet) return true
  }
  return false
}
export async function runLoki(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{ summary: string; actionsQueued: number }> {
  const db = createServiceClient()
  const warnings: string[] = []

  try {
    // 0. Resolve site
    const site = await getSiteUrlForSlug(db, siteSlug)
    const ourDomain = site.domain

    // 1. Get active competitors
    const { data: competitors, error: compErr } = await db
      .from('competitors')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('active', true)

    if (compErr) throw new Error(`competitors lookup failed: ${compErr.message}`)
    if (!competitors?.length) {
      const summary = 'No active competitors configured. Add at least one in Competitive settings.'
      await _finishRun(db, runId, ownerId, 'success', summary, 0, 0, warnings)
      return { summary, actionsQueued: 0 }
    }

    const LOCATION_CODE = 2840   // United States
    const LANGUAGE_CODE = 'en'
    const FETCH_LIMIT   = 100

    let actionsQueued = 0
    const findings: string[] = []

    // Build branded-keyword blocklist with stricter token detection.
    // Block by *whole-word* match (regex with \b) to avoid overblocking
    // generic terms ("steam" inside "steamhide" is fine, but "steam" alone
    // from a "store.steampowered.com" competitor should still match).
    const brandTokens = new Set<string>(['g2g'])
    for (const c of competitors) {
      const domain = String(c.domain).toLowerCase()
      // primary brand token: domain with TLD stripped
      const labels = domain.split('.').filter(Boolean)
      // Skip generic prefixes / public suffixes
      const skipLabels = new Set(['www', 'store', 'shop', 'blog', 'forum', 'wiki', 'com', 'net', 'org', 'co', 'io'])
      for (const lab of labels) {
        if (lab.length >= 3 && !skipLabels.has(lab)) {
          brandTokens.add(lab)
        }
      }
    }

    const isBranded = (kw: string) => {
      const k = kw.toLowerCase()
      for (const t of brandTokens) {
        // whole-word match — token at word boundary
        if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(k)) return true
      }
      return false
    }

    // 2. Keyword gap analysis — DataForSEO
    let gapAnalysisFailed = false
    const competitorsToAnalyze = competitors.slice(0, 3)

    // Pre-load already-pending/approved Loki keyword gap actions so we can
    // skip redundant re-queues across multiple runs.
    const { data: pendingLokiActions } = await db
      .from('agent_actions')
      .select('data')
      .eq('owner_user_id', ownerId)
      .eq('agent_key', 'loki')
      .in('status', ['pending', 'approved'])

    // Global keyword dedup set — grows during this run AND pre-seeded from DB.
    // Used by: (a) cross-run dedup, (b) near-duplicate detection within run.
    const allQueuedKeywords = new Set<string>(
      (pendingLokiActions ?? [])
        .map(a => String((a.data as Record<string, unknown>)?.keyword ?? '').toLowerCase())
        .filter(Boolean)
    )
    const redundantSkipped  = { count: 0, keywords: [] as string[] }

    try {
      const ourKwsP    = getDomainRankedKeywords(ourDomain, LOCATION_CODE, LANGUAGE_CODE, FETCH_LIMIT)
      const compKwsP   = competitorsToAnalyze.map(c =>
        getDomainRankedKeywords(c.domain, LOCATION_CODE, LANGUAGE_CODE, FETCH_LIMIT)
      )
      // Log DataForSEO calls (1 per domain analysed)
      const totalDfsCalls = 1 + competitorsToAnalyze.length
      logApiUsage(db, ownerId, {
        api:         'dataforseo',
        endpoint:    'dataforseo_labs/google/ranked_keywords',
        triggeredBy: 'agent_loki',
        callCount:   totalDfsCalls,
        metadata:    { domains: [ourDomain, ...competitorsToAnalyze.map(c => c.domain)] },
      })
      // Use allSettled so one slow/failing competitor doesn't kill the others
      const [ourSettled, ...compSettled] = await Promise.allSettled([ourKwsP, ...compKwsP])

      if (ourSettled.status === 'rejected') {
        throw new Error(`DataForSEO call for our domain failed: ${ourSettled.reason instanceof Error ? ourSettled.reason.message : ourSettled.reason}`)
      }
      const ourKws = ourSettled.value

      // G2G map: keyword → position
      const ourMap = new Map(ourKws.map(k => [k.keyword?.toLowerCase(), k]))

      for (let i = 0; i < competitorsToAnalyze.length; i++) {
        const competitor = competitorsToAnalyze[i]
        const settled    = compSettled[i]

        if (settled.status === 'rejected') {
          warnings.push(`DataForSEO failed for ${competitor.domain}: ${settled.reason instanceof Error ? settled.reason.message : settled.reason}`)
          continue
        }

        const compKws = settled.value

        const gaps = compKws.filter(ck => {
          const kw         = ck.keyword?.toLowerCase()
          const ourRanking = kw ? ourMap.get(kw) : undefined
          return (ck.position ?? 999) <= 10
            && (!ourRanking || (ourRanking.position ?? 999) > 20)
            && kw
            && !isBranded(kw)
            && isEnglishKeyword(kw)
        })

        // Sort by SV — used both for queueing and findings persistence
        const sortedGaps = gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))

        // Queue top 3 gaps per competitor after applying cross-run + near-dup dedup.
        // A keyword is skipped if:
        //   (a) already pending/approved from a previous run, OR
        //   (b) already queued this run AND is a near-duplicate of it
        const topGaps: typeof sortedGaps = []
        for (const g of sortedGaps) {
          if (topGaps.length >= 3) break
          const kw = g.keyword?.toLowerCase() ?? ''
          if (!kw) continue
          if (allQueuedKeywords.has(kw)) {
            redundantSkipped.count++
            redundantSkipped.keywords.push(kw)
            continue
          }
          if (isNearDuplicate(kw, allQueuedKeywords)) {
            redundantSkipped.count++
            redundantSkipped.keywords.push(kw)
            continue
          }
          topGaps.push(g)
        }
        const topGapKeywords = new Set(topGaps.map(g => g.keyword?.toLowerCase() ?? ''))

        // Persist ALL discovered gaps (up to 50/competitor) as findings —
        // even ones we don't queue as actions. This is what powers the
        // /competitive pages so users can browse historical gap data.
        const gapFindings: LokiKeywordGapData[] = sortedGaps.slice(0, 50).map(g => {
          const ourPos = g.keyword ? ourMap.get(g.keyword.toLowerCase())?.position ?? null : null
          const volume = g.volume ?? 0
          return {
            keyword:             g.keyword ?? '',
            competitor_domain:   competitor.domain,
            competitor_position: g.position ?? 0,
            competitor_url:      g.url ?? null,
            our_position:        ourPos,
            search_volume:       volume,
            cpc:                 0,
            queued_as_action:    topGapKeywords.has(g.keyword?.toLowerCase() ?? ''),
            is_high_value:       volume >= 10000 && (!ourPos || ourPos > 50),
          }
        })

        await persistFindingsBulk(db, gapFindings.map(d => ({
          agentKey:    'loki',
          ownerId,
          runId,
          siteSlug,
          findingType: 'keyword_gap',
          subject:     d.keyword,
          severity:    d.search_volume >= 10000 ? 'high'
                      : d.search_volume >= 1000  ? 'medium' : 'low',
          data:        d as unknown as Record<string, unknown>,
        })))

        // Per-competitor summary finding — one row per competitor analysed,
        // useful for the competitor leaderboard widget.
        const competitorSummary: LokiCompetitorSummaryData = {
          domain:              competitor.domain,
          total_keywords:      compKws.length,
          top10_count:         compKws.filter(k => (k.position ?? 999) <= 10).length,
          gaps_found:          gaps.length,
          sample_gap_keywords: topGaps.map(g => g.keyword ?? '').filter(Boolean).slice(0, 5),
        }
        await persistFinding(db, {
          agentKey:    'loki',
          ownerId,
          runId,
          siteSlug,
          findingType: 'competitor_summary',
          subject:     competitor.domain,
          severity:    'info',
          data:        competitorSummary as unknown as Record<string, unknown>,
        })

        for (const gap of topGaps) {
          if (actionsQueued >= 10) break
          const volume   = gap.volume ?? 0
          const priority = volume > 5000 ? 'high' : volume > 1000 ? 'medium' : 'low'
          const ourPos   = ourMap.get(gap.keyword?.toLowerCase() ?? '')?.position
          // Fast-path: high-volume gaps where we don't already rank go directly
          // to a Bragi handoff. Threshold = SV ≥ 10k. One approval = one brief.
          const isHighValue = volume >= 10000 && (!ourPos || ourPos > 50)

          const description = [
            `${competitor.domain} ranks #${gap.position} for "${gap.keyword}" (${volume.toLocaleString()} monthly searches).`,
            ourPos ? `We rank #${ourPos} (page ${Math.ceil(ourPos / 10)}+).` : `We don't rank in top 100.`,
            isHighValue
              ? `⚡ High-value gap — approve to auto-draft a brief via Bragi.`
              : `Recommended action: ${ourPos && ourPos < 50 ? 'on-page optimisation of existing page' : 'create a new dedicated page targeting this term'}.`,
          ].join(' ')

          // Soft universe enforcement: tag with cluster/topic match if any.
          const universe = await lookupKeywordInUniverse(db, ownerId, gap.keyword ?? '')

          const sharedData = {
            keyword:             gap.keyword,
            competitor_domain:   competitor.domain,
            competitor_url:      gap.url ?? null,
            competitor_position: gap.position,
            our_position:        ourPos ?? null,
            search_volume:       volume,
            keyword_map_cluster_id: universe.keyword_map_cluster_id,
            keyword_map_id:         universe.keyword_map_id,
            topic:                  universe.topic,
            outside_universe:       universe.outside_universe,
          }

          let insertErr
          if (isHighValue) {
            ;({ error: insertErr } = await db
              .from('agent_actions')
              .insert({
                owner_user_id: ownerId,
                agent_key:     'loki',
                run_id:        runId,
                site_slug:     siteSlug,
                action_type:   'run_agent',
                title:         `⚡ High-value gap: "${gap.keyword}" (${volume.toLocaleString()} SV) — draft brief?`,
                description,
                priority:      'high',
                data: {
                  handoff_to: 'bragi',
                  context:    'loki_high_value_gap',
                  payload: {
                    keyword:        gap.keyword,
                    competitor_url: gap.url ?? null,
                    search_volume:  volume,
                    source_agent:   'loki',
                    brief_type:     'on_page',
                    context:        `Competitor ${competitor.domain} ranks #${gap.position} for this term. We don't rank in top 50.`,
                  },
                  ...sharedData,
                  fast_path:      true,
                  action_type:    'new_page',
                },
              }))
          } else {
            ;({ error: insertErr } = await db
              .from('agent_actions')
              .insert({
                owner_user_id: ownerId,
                agent_key:     'loki',
                run_id:        runId,
                site_slug:     siteSlug,
                action_type:   'add_action_item',
                title:         `Keyword gap: "${gap.keyword}" — ${competitor.domain} #${gap.position}`,
                description,
                priority,
                data: {
                  ...sharedData,
                  cpc:         0,
                  action_type: ourPos && ourPos < 50 ? 'on_page' : 'new_page',
                },
              }))
          }

          if (insertErr) {
            console.error('[loki] insert failed:', insertErr.message)
          } else {
            actionsQueued++
            // Register in global set so near-dup check works within this run too
            allQueuedKeywords.add((gap.keyword ?? '').toLowerCase())
            findings.push(`Gap: "${gap.keyword}" (${volume.toLocaleString()} vol, ${competitor.domain} #${gap.position})`)
          }
        }
      }
    } catch (gapErr) {
      const msg = gapErr instanceof Error ? gapErr.message : String(gapErr)
      warnings.push(`Keyword gap analysis failed: ${msg}`)
      gapAnalysisFailed = true
      console.warn('[loki] Keyword gap analysis failed:', gapErr)
    }

    // 3. SOV delta analysis — uses serp_snapshots, RELATIVE % change
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const sixtyDaysAgo  = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

      // STRICT non-overlap: recent ≥ thirtyDaysAgo, older [sixty, thirty)
      const [{ data: recentSnaps, error: recentErr }, { data: olderSnaps, error: olderErr }] = await Promise.all([
        db.from('serp_snapshots')
          .select('keyword, results')
          .eq('owner_user_id', ownerId)
          .gte('snapshot_date', thirtyDaysAgo),
        db.from('serp_snapshots')
          .select('keyword, results')
          .eq('owner_user_id', ownerId)
          .gte('snapshot_date', sixtyDaysAgo)
          .lt('snapshot_date', thirtyDaysAgo),
      ])

      if (recentErr) warnings.push(`SOV recent snaps query failed: ${recentErr.message}`)
      if (olderErr)  warnings.push(`SOV older snaps query failed: ${olderErr.message}`)

      if (recentSnaps && recentSnaps.length > 0) {
        type FlatRow = { domain: string; position: number }
        const flatten = (snaps: { results: unknown }[]): FlatRow[] =>
          snaps.flatMap(s =>
            ((s.results ?? []) as FlatRow[]).filter(r => r.domain && r.position)
          )

        const recentRows = flatten(recentSnaps)
        const olderRows  = flatten(olderSnaps ?? [])

        const calcSOV = (rows: FlatRow[]) => {
          const sov = new Map<string, number>()
          for (const r of rows) {
            if (r.position <= 10) sov.set(r.domain, (sov.get(r.domain) ?? 0) + 1)
          }
          return sov
        }

        const recentSOV = calcSOV(recentRows)
        const olderSOV  = calcSOV(olderRows)

        const ourRecent = recentSOV.get(ourDomain) ?? 0
        const ourOlder  = olderSOV.get(ourDomain)  ?? 0
        const sovChange = ourRecent - ourOlder
        const sovPct    = ourOlder > 0 ? (sovChange / ourOlder) * 100 : 0

        // Build lost keyword sample upfront — used both by action queue
        // path AND the SoV snapshot finding (which persists every run).
        const lostKwSamplePersist: string[] = []
        if (recentSnaps && olderSnaps) {
          const presenceRecent = new Map<string, boolean>()
          const presenceOlder  = new Map<string, boolean>()
          for (const s of recentSnaps) {
            const hit = ((s.results ?? []) as FlatRow[]).some(r => r.domain === ourDomain && r.position <= 10)
            presenceRecent.set(String((s as { keyword: string }).keyword), hit)
          }
          for (const s of olderSnaps) {
            const hit = ((s.results ?? []) as FlatRow[]).some(r => r.domain === ourDomain && r.position <= 10)
            presenceOlder.set(String((s as { keyword: string }).keyword), hit)
          }
          for (const [kw, was] of presenceOlder.entries()) {
            if (was && !presenceRecent.get(kw)) lostKwSamplePersist.push(kw)
            if (lostKwSamplePersist.length >= 10) break
          }
        }

        // Persist SoV snapshot — every Loki run produces one row, so the
        // /competitive pages have historical SoV data to chart.
        const sovSnapshot: LokiSovSnapshotData = {
          our_domain:             ourDomain,
          our_recent_sov:         ourRecent,
          our_older_sov:          ourOlder,
          sov_change:             sovChange,
          sov_change_pct:         sovPct,
          top_competitors_recent: Array.from(recentSOV.entries())
            .filter(([d]) => d !== ourDomain)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10),
          top_competitors_older:  Array.from(olderSOV.entries())
            .filter(([d]) => d !== ourDomain)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10),
          lost_keywords:          lostKwSamplePersist,
          recent_window_start:    thirtyDaysAgo,
          older_window_start:     sixtyDaysAgo,
          total_keywords_tracked: recentSnaps.length,
          triggered_action:       sovPct <= -20 && sovChange <= -3,
        }
        await persistFinding(db, {
          agentKey:    'loki',
          ownerId,
          runId,
          siteSlug,
          findingType: 'sov_snapshot',
          subject:     ourDomain,
          severity:    sovPct <= -20 ? 'high' : sovPct <= -10 ? 'medium' : 'info',
          data:        sovSnapshot as unknown as Record<string, unknown>,
        })

        // Trigger ONLY if relative drop ≥ 20% AND absolute drop ≥ 3 positions
        // (avoids noise in low-volume segments)
        if (sovPct <= -20 && sovChange <= -3 && actionsQueued < 10) {
          // Find the competitor that gained the most
          const topGainer = Array.from(recentSOV.entries())
            .filter(([d]) => competitors.some(c => c.domain === d))
            .sort((a, b) => b[1] - a[1])[0]

          // Reuse lostKwSamplePersist computed above (same algorithm,
          // already populated with up to 10 lost keywords). The action
          // description previously used a separate 5-entry computation.
          const lostKwSample = lostKwSamplePersist.slice(0, 5)

          const description = [
            `Top-10 SOV dropped from ${ourOlder} → ${ourRecent} keywords (-${Math.abs(sovChange)}, -${Math.abs(sovPct).toFixed(1)}%) over the last 30 days.`,
            topGainer ? `Biggest competitor gainer: ${topGainer[0]} (${topGainer[1]} top-10 keywords).` : '',
            lostKwSample.length
              ? `Sample of lost terms: ${lostKwSample.slice(0, 3).map(k => `"${k}"`).join(', ')}${lostKwSample.length > 3 ? '…' : ''}`
              : '',
            `Recommended: review on-page content and backlink velocity for the lost keywords.`,
          ].filter(Boolean).join(' ')

          const { error: insertErr } = await db
            .from('agent_actions')
            .insert({
              owner_user_id: ownerId,
              agent_key:     'loki',
              run_id:        runId,
              site_slug:     siteSlug,
              action_type:   'add_action_item',
              title:         `SOV dropped ${Math.abs(sovPct).toFixed(0)}% — ${topGainer ? `${topGainer[0]} gained` : 'no single gainer identified'}`,
              description,
              priority:      'high',
              data: {
                sov_change:      sovChange,
                sov_change_pct:  sovPct,
                top_gainer:      topGainer?.[0] ?? null,
                top_gainer_sov:  topGainer?.[1] ?? null,
                our_recent_sov:  ourRecent,
                our_older_sov:   ourOlder,
                lost_keywords:   lostKwSample,
                action_type:     'competitive_review',
              },
            })

          if (insertErr) {
            console.error('[loki] SOV insert failed:', insertErr.message)
          } else {
            actionsQueued++
            findings.push(`SOV dropped ${Math.abs(sovPct).toFixed(0)}% (top gainer: ${topGainer?.[0] ?? 'unknown'})`)
          }
        }
      }
    } catch (sovErr) {
      const msg = sovErr instanceof Error ? sovErr.message : String(sovErr)
      warnings.push(`SOV analysis failed: ${msg}`)
      console.warn('[loki] SOV analysis failed:', sovErr)
    }

    const redundantNote = redundantSkipped.count > 0
      ? ` Skipped ${redundantSkipped.count} redundant/near-duplicate keyword${redundantSkipped.count !== 1 ? 's' : ''} already in queue (${redundantSkipped.keywords.slice(0, 3).map(k => `"${k}"`).join(', ')}${redundantSkipped.keywords.length > 3 ? '…' : ''}).`
      : ''
    const summaryBase = `Analyzed ${competitorsToAnalyze.length} competitor${competitorsToAnalyze.length !== 1 ? 's' : ''} via DataForSEO. Found ${findings.length} insight${findings.length !== 1 ? 's' : ''}. Queued ${actionsQueued} action${actionsQueued !== 1 ? 's' : ''}.${redundantNote}`
    const summary = warnings.length ? `${summaryBase} ⚠ ${warnings.join('; ')}` : summaryBase

    // Status: partial if gap analysis blew up entirely (we yielded 0 from it)
    // OR if we have any warnings. Otherwise success.
    const status = (gapAnalysisFailed || warnings.length > 0) ? 'partial' : 'success'

    await _finishRun(db, runId, ownerId, status, summary, findings.length, actionsQueued, warnings)
    return { summary, actionsQueued }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    await _finishRun(db, runId, ownerId, 'error', msg, 0, 0, warnings, msg)
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
    .eq('agent_key', 'loki')
}
