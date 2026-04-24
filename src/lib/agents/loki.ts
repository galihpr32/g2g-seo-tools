import { createServiceClient } from '@/lib/supabase/service'
import { getDomainRankedKeywords } from '@/lib/dataforseo/client'

/**
 * Loki — Competitive Analysis Agent
 *
 * Logic:
 * 1. Get active competitor list from DB
 * 2. Keyword gap analysis via DataForSEO: keywords competitors rank top-10 but G2G doesn't
 * 3. SOV delta via serp_snapshots: compare G2G top-10 share vs 30 days ago
 * 4. Queue agent_actions for findings (max 10 per run)
 */
export async function runLoki(
  ownerId: string,
  siteSlug: string,
  runId: string
): Promise<{ summary: string; actionsQueued: number }> {
  const db = createServiceClient()

  try {
    // 1. Get active competitors
    const { data: competitors, error: compErr } = await db
      .from('competitors')
      .select('*')
      .eq('owner_user_id', ownerId)
      .eq('active', true)

    if (compErr || !competitors?.length) {
      return { summary: 'No active competitors configured.', actionsQueued: 0 }
    }

    const G2G_DOMAIN    = 'g2g.com'
    const LOCATION_CODE = 2840   // United States
    const LANGUAGE_CODE = 'en'
    const FETCH_LIMIT   = 100

    let actionsQueued = 0
    const findings: string[] = []

    // Build branded-keyword blocklist so we don't flag brand terms as "gaps"
    const brandedTerms = new Set<string>(['g2g', 'g2g.com'])
    for (const c of competitors) {
      const domain = c.domain.toLowerCase()
      brandedTerms.add(domain)
      brandedTerms.add(domain.split('.')[0])
      brandedTerms.add(domain.replace(/\./g, ' '))
    }

    const isBranded = (kw: string) => {
      const k = kw.toLowerCase()
      for (const t of brandedTerms) { if (k.includes(t)) return true }
      return false
    }

    // 2. Keyword gap analysis — DataForSEO (replaces SEMrush)
    try {
      const [g2gKws, ...allCompKws] = await Promise.all([
        getDomainRankedKeywords(G2G_DOMAIN, LOCATION_CODE, LANGUAGE_CODE, FETCH_LIMIT),
        ...competitors.slice(0, 3).map(c =>
          getDomainRankedKeywords(c.domain, LOCATION_CODE, LANGUAGE_CODE, FETCH_LIMIT)
        ),
      ])

      // G2G map: keyword → position
      const g2gMap = new Map(g2gKws.map(k => [k.keyword?.toLowerCase(), k]))

      for (let i = 0; i < competitors.slice(0, 3).length; i++) {
        const competitor  = competitors[i]
        const compKws     = allCompKws[i]

        const gaps = compKws.filter(ck => {
          const kw         = ck.keyword?.toLowerCase()
          const ourRanking = kw ? g2gMap.get(kw) : undefined
          return (ck.position ?? 999) <= 10
            && (!ourRanking || (ourRanking.position ?? 999) > 20)
            && kw && !isBranded(kw)
        })

        // Queue top 3 gaps per competitor, sorted by search volume
        const topGaps = gaps
          .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))
          .slice(0, 3)

        for (const gap of topGaps) {
          if (actionsQueued >= 10) break
          const volume   = gap.volume ?? 0
          const priority = volume > 1000 ? 'high' : 'medium'

          const { error: insertErr } = await db
            .from('agent_actions')
            .insert({
              owner_user_id: ownerId,
              agent_key:     'loki',
              run_id:        runId,
              site_slug:     siteSlug,
              action_type:   'add_action_item',
              title:         `Keyword gap: "${gap.keyword}" — ${competitor.domain} #${gap.position}, G2G not ranking`,
              description:   `${competitor.domain} ranks #${gap.position} for "${gap.keyword}" (${volume.toLocaleString()} monthly searches). G2G doesn't rank. Recommend on-page content update or new page creation.`,
              priority,
              data: {
                keyword:             gap.keyword,
                competitor_domain:   competitor.domain,
                competitor_position: gap.position,
                our_position:        g2gMap.get(gap.keyword?.toLowerCase())?.position ?? null,
                search_volume:       volume,
                cpc:                 0,   // DataForSEO ranked_keywords doesn't return CPC
                action_type:         'on_page',
              },
            })

          if (!insertErr) {
            actionsQueued++
            findings.push(`Gap: "${gap.keyword}" (${volume.toLocaleString()} vol, ${competitor.domain} #${gap.position})`)
          }
        }
      }
    } catch (gapErr) {
      console.warn('[loki] Keyword gap analysis failed:', gapErr)
    }

    // 3. SOV delta analysis — uses serp_snapshots (results jsonb array)
    // serp_snapshots schema: { keyword, snapshot_date, results: [{domain, position, url, title}] }
    // We flatten the results in JS since Supabase doesn't support lateral joins in the JS client.
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const sixtyDaysAgo  = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

      const [{ data: recentSnaps }, { data: olderSnaps }] = await Promise.all([
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

      if (recentSnaps && recentSnaps.length > 0) {
        // Flatten results[] into flat rows
        type FlatRow = { domain: string; position: number }
        const flatten = (snaps: { results: unknown }[]): FlatRow[] =>
          snaps.flatMap(s =>
            ((s.results ?? []) as FlatRow[]).filter(r => r.domain && r.position)
          )

        const recentRows = flatten(recentSnaps)
        const olderRows  = flatten(olderSnaps ?? [])

        // SOV = count of top-10 appearances per domain
        const calcSOV = (rows: FlatRow[]) => {
          const sov = new Map<string, number>()
          for (const r of rows) {
            if (r.position <= 10) sov.set(r.domain, (sov.get(r.domain) ?? 0) + 1)
          }
          return sov
        }

        const recentSOV = calcSOV(recentRows)
        const olderSOV  = calcSOV(olderRows)

        const ourRecent = recentSOV.get(G2G_DOMAIN) ?? 0
        const ourOlder  = olderSOV.get(G2G_DOMAIN)  ?? 0
        const sovChange = ourRecent - ourOlder

        if (sovChange < -5) {
          // Find the competitor that gained the most
          const topGainer = Array.from(recentSOV.entries())
            .filter(([d]) => competitors.some(c => c.domain === d))
            .sort((a, b) => b[1] - a[1])[0]

          if (topGainer && actionsQueued < 10) {
            const { error: insertErr } = await db
              .from('agent_actions')
              .insert({
                owner_user_id: ownerId,
                agent_key:     'loki',
                run_id:        runId,
                site_slug:     siteSlug,
                action_type:   'add_action_item',
                title:         `SOV dropped ${Math.abs(sovChange)} positions — ${topGainer[0]} gained`,
                description:   `G2G's SERP visibility dropped ${Math.abs(sovChange)} top-10 positions in the last 30 days. ${topGainer[0]} is the biggest gainer (${topGainer[1]} top-10 appearances). Recommend a competitive content review.`,
                priority:      'high',
                data: {
                  sov_change:      sovChange,
                  top_gainer:      topGainer[0],
                  our_recent_sov:  ourRecent,
                  our_older_sov:   ourOlder,
                  action_type:     'off_page',
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

    const summary = `Analyzed ${Math.min(competitors.length, 3)} competitors via DataForSEO. Found ${findings.length} insight${findings.length !== 1 ? 's' : ''}. Queued ${actionsQueued} action${actionsQueued !== 1 ? 's' : ''}.`

    await db.from('agent_runs').update({
      status:          'success',
      summary,
      findings_count:  findings.length,
      actions_queued:  actionsQueued,
      finished_at:     new Date().toISOString(),
    }).eq('id', runId)

    await db.from('agents').update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  'success',
      last_run_summary: summary,
    }).eq('owner_user_id', ownerId).eq('agent_key', 'loki')

    return { summary, actionsQueued }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'

    await db.from('agent_runs').update({
      status:         'error',
      error_message:  msg,
      finished_at:    new Date().toISOString(),
    }).eq('id', runId)

    await db.from('agents').update({
      last_run_at:      new Date().toISOString(),
      last_run_status:  'error',
      last_run_summary: msg,
    }).eq('owner_user_id', ownerId).eq('agent_key', 'loki')

    throw err
  }
}
