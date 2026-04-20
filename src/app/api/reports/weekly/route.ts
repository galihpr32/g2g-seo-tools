import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getSiteConfig } from '@/lib/sites'
import { getDomainKeywords, getDomainOverview } from '@/lib/semrush/client'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getGA4Report, parseGA4Rows, sumMetric } from '@/lib/ga4/client'
import Anthropic from '@anthropic-ai/sdk'

// CTR curve for SoV calculation (positions 1–10)
const CTR_CURVE: Record<number, number> = {
  1: 0.284, 2: 0.146, 3: 0.099, 4: 0.073, 5: 0.057,
  6: 0.045, 7: 0.036, 8: 0.029, 9: 0.023, 10: 0.019,
}
function normalizeDomain(d: string) { return d.replace(/^www\./, '').toLowerCase() }

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Date helpers ──────────────────────────────────────────────────────────────

function getThursdayWeekRange(offsetWeeks = 0): { start: string; end: string; label: string } {
  const now = new Date()
  const day = now.getDay()
  const daysSinceWed = (day + 4) % 7
  const lastWed = new Date(now)
  lastWed.setDate(now.getDate() - daysSinceWed - offsetWeeks * 7)
  lastWed.setHours(0, 0, 0, 0)
  const thu = new Date(lastWed)
  thu.setDate(lastWed.getDate() - 6)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const label = `${thu.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${lastWed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
  return { start: fmt(thu), end: fmt(lastWed), label }
}

function pctChange(current: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((current - prev) / prev) * 100)
}

// ── GET /api/reports/weekly ───────────────────────────────────────────────────
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { searchParams } = new URL(req.url)
  const id   = searchParams.get('id')
  const site = searchParams.get('site') ?? 'g2g'

  if (id) {
    const { data, error } = await supabase
      .from('weekly_reports')
      .select('*')
      .eq('id', id)
      .eq('owner_user_id', ownerId)
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ report: data })
  }

  const { data, error } = await supabase
    .from('weekly_reports')
    .select('id, week_start, week_end, created_at, ai_narrative, site_slug')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', site)
    .order('week_start', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data ?? [] })
}

// ── POST /api/reports/weekly ──────────────────────────────────────────────────
// Body: { site?: string, week_start?: string, week_end?: string }
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const ownerId = await getEffectiveOwnerId(supabase, user.id)
    const body = await req.json().catch(() => ({}))

    // ── Resolve site config ──────────────────────────────────────────────────
    const siteSlug = (body.site as string) ?? 'g2g'
    const siteConfig = await getSiteConfig(supabase, siteSlug)
    if (!siteConfig) {
      return NextResponse.json({ error: `Unknown site: ${siteSlug}` }, { status: 400 })
    }

    // Resolve week range
    const defaultRange = getThursdayWeekRange(0)
    const weekStart = (body.week_start as string) ?? defaultRange.start
    const weekEnd   = (body.week_end   as string) ?? defaultRange.end

    // Check for existing report for this site + week, delete and regenerate
    const { data: existing } = await supabase
      .from('weekly_reports')
      .select('id')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('week_start', weekStart)
      .maybeSingle()
    if (existing) {
      await supabase.from('weekly_reports').delete().eq('id', existing.id)
    }

    // Get owner's GSC connection (tokens are shared for all sites)
    const { data: conn } = await supabase
      .from('gsc_connections')
      .select('site_url, access_token, refresh_token, expires_at')
      .eq('user_id', ownerId)
      .maybeSingle()

    // Use site config's GSC property URL (not conn.site_url which is the selected property)
    const siteUrl = siteConfig.gsc_property

    // ── Previous week range ──────────────────────────────────────────────────
    const ws = new Date(weekStart)
    const prevEnd   = new Date(ws); prevEnd.setDate(ws.getDate() - 1)
    const prevStart = new Date(prevEnd); prevStart.setDate(prevEnd.getDate() - 6)
    const prevWeekStart = prevStart.toISOString().slice(0, 10)
    const prevWeekEnd   = prevEnd.toISOString().slice(0, 10)

    // ── Fetch all data in parallel ───────────────────────────────────────────
    const [
      gscCurrent,
      gscPrevious,
      actionItemsAll,
      actionItemsThisWeek,
      competitors,
    ] = await Promise.all([
      supabase
        .from('gsc_ranking_snapshots')
        .select('page, clicks, impressions, ctr, position, snapshot_date')
        .eq('site_url', siteUrl)
        .gte('snapshot_date', weekStart)
        .lte('snapshot_date', weekEnd),

      supabase
        .from('gsc_ranking_snapshots')
        .select('page, clicks, impressions, ctr, position, snapshot_date')
        .eq('site_url', siteUrl)
        .gte('snapshot_date', prevWeekStart)
        .lte('snapshot_date', prevWeekEnd),

      supabase
        .from('seo_action_items')
        .select('id, status, assigned_to, created_at, completed_at, action_type')
        .eq('site_url', siteUrl),

      supabase
        .from('seo_action_items')
        .select('id, status, assigned_to, action_type, created_at, completed_at')
        .eq('site_url', siteUrl)
        .or(`created_at.gte.${weekStart},completed_at.gte.${weekStart}`),

      supabase
        .from('competitors')
        .select('domain, name, active')
        .eq('owner_user_id', ownerId)
        .eq('active', true)
        .limit(5),
    ])

    // ── Process GSC — fallback to live API if no snapshot data ──────────────
    let curSnaps  = gscCurrent.data  ?? []
    let prevSnaps = gscPrevious.data ?? []

    if (curSnaps.length === 0 && conn?.access_token) {
      try {
        const gscAuth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
        const [curRows, prevRows] = await Promise.all([
          getSearchAnalytics(gscAuth, siteUrl, weekStart, weekEnd, ['page'], 1000),
          getSearchAnalytics(gscAuth, siteUrl, prevWeekStart, prevWeekEnd, ['page'], 1000),
        ])
        curSnaps = curRows.map(r => ({
          page:          r.keys?.[0] ?? '',
          clicks:        r.clicks ?? 0,
          impressions:   r.impressions ?? 0,
          ctr:           r.ctr ?? 0,
          position:      r.position ?? 0,
          snapshot_date: weekEnd,
        }))
        prevSnaps = prevRows.map(r => ({
          page:          r.keys?.[0] ?? '',
          clicks:        r.clicks ?? 0,
          impressions:   r.impressions ?? 0,
          ctr:           r.ctr ?? 0,
          position:      r.position ?? 0,
          snapshot_date: prevWeekEnd,
        }))
      } catch (e) {
        console.warn('[weekly-report] GSC live API fallback failed:', e)
      }
    }

    const sumBy = (rows: typeof curSnaps) => {
      let clicks = 0, impressions = 0, posSum = 0, count = 0
      const pageMap = new Map<string, { clicks: number; impressions: number }>()
      for (const r of rows) {
        clicks      += r.clicks ?? 0
        impressions += r.impressions ?? 0
        posSum      += r.position ?? 0
        count++
        const p = pageMap.get(r.page) ?? { clicks: 0, impressions: 0 }
        p.clicks      += r.clicks ?? 0
        p.impressions += r.impressions ?? 0
        pageMap.set(r.page, p)
      }
      const ctr = impressions > 0 ? +(clicks / impressions * 100).toFixed(2) : 0
      return { clicks, impressions, avgPosition: count ? +(posSum / count).toFixed(1) : 0, ctr, pageMap }
    }

    const cur  = sumBy(curSnaps)
    const prev = sumBy(prevSnaps)

    const pageMovers: { page: string; curClicks: number; prevClicks: number; delta: number }[] = []
    for (const [page, c] of cur.pageMap.entries()) {
      const p = prev.pageMap.get(page) ?? { clicks: 0, impressions: 0 }
      pageMovers.push({ page, curClicks: c.clicks, prevClicks: p.clicks, delta: c.clicks - p.clicks })
    }
    pageMovers.sort((a, b) => b.delta - a.delta)
    const topGainers = pageMovers.slice(0, 5).filter(p => p.delta > 0)
    const topDroppers = pageMovers.slice(-5).reverse().filter(p => p.delta < 0)

    const gscData = {
      weekClicks:          cur.clicks,
      prevWeekClicks:      prev.clicks,
      clicksPct:           pctChange(cur.clicks, prev.clicks),
      weekImpressions:     cur.impressions,
      prevWeekImpressions: prev.impressions,
      impressionsPct:      pctChange(cur.impressions, prev.impressions),
      weekCtr:             cur.ctr,
      prevWeekCtr:         prev.ctr,
      ctrPct:              pctChange(Math.round(cur.ctr * 100), Math.round(prev.ctr * 100)),
      avgPosition:         cur.avgPosition,
      totalUniquePages:    cur.pageMap.size,
      topGainers:          topGainers.map(p => ({ page: p.page, delta: p.delta, clicks: p.curClicks })),
      topDroppers:         topDroppers.map(p => ({ page: p.page, delta: p.delta, clicks: p.curClicks })),
    }

    // ── Action Items ─────────────────────────────────────────────────────────
    const allItems  = actionItemsAll.data  ?? []
    const weekItems = actionItemsThisWeek.data ?? []

    const assigneeMap = new Map<string, { assigned: number; completed: number; inProgress: number }>()
    for (const item of allItems) {
      const key = item.assigned_to ?? '(unassigned)'
      if (!assigneeMap.has(key)) assigneeMap.set(key, { assigned: 0, completed: 0, inProgress: 0 })
      const e = assigneeMap.get(key)!
      e.assigned++
      if (item.status === 'done')        e.completed++
      if (item.status === 'in_progress') e.inProgress++
    }

    const actionItemsData = {
      total:             allItems.length,
      pending:           allItems.filter(i => i.status === 'pending').length,
      inProgress:        allItems.filter(i => i.status === 'in_progress').length,
      done:              allItems.filter(i => i.status === 'done').length,
      assignedThisWeek:  weekItems.filter(i => i.created_at >= weekStart).length,
      completedThisWeek: weekItems.filter(i => i.status === 'done' && (i.completed_at ?? '') >= weekStart).length,
      byAssignee: Array.from(assigneeMap.entries())
        .map(([email, c]) => ({ email, ...c }))
        .filter(a => a.assigned > 0)
        .sort((a, b) => b.assigned - a.assigned)
        .slice(0, 8),
    }

    // ── SEMrush keywords + domain authority (site-specific domain) ───────────
    const semrushDomain = siteConfig.semrush_domain
    let semrushData: {
      totalKeywords: number; top3: number; top10: number
      topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]
      topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[]
    } = { totalKeywords: 0, top3: 0, top10: 0, topMoversUp: [], topMoversDown: [] }

    let domainAuthority: {
      organicKeywords: number; organicTraffic: number; organicCost: number; rank: number
    } | null = null

    try {
      const [keywords, overview] = await Promise.all([
        getDomainKeywords(semrushDomain, 'us', 500),
        getDomainOverview(semrushDomain, 'us').catch(() => null),
      ])
      const up   = keywords.filter(k => k.positionDiff > 0).sort((a, b) => b.positionDiff - a.positionDiff).slice(0, 8)
      const down = keywords.filter(k => k.positionDiff < 0).sort((a, b) => a.positionDiff - b.positionDiff).slice(0, 8)
      semrushData = {
        totalKeywords: keywords.length,
        top3:  keywords.filter(k => k.position <= 3).length,
        top10: keywords.filter(k => k.position <= 10).length,
        topMoversUp:   up.map(k => ({ keyword: k.keyword, position: k.position, positionDiff: k.positionDiff, volume: k.searchVolume })),
        topMoversDown: down.map(k => ({ keyword: k.keyword, position: k.position, positionDiff: k.positionDiff, volume: k.searchVolume })),
      }
      if (overview) {
        domainAuthority = {
          organicKeywords: overview.organicKeywords,
          organicTraffic:  overview.organicTraffic,
          organicCost:     overview.organicCost,
          rank:            overview.rank,
        }
      }
    } catch (e) {
      console.warn('[weekly-report] SEMrush fetch failed:', e)
    }

    // ── GA4 (site-specific property ID) ─────────────────────────────────────
    // Use ga4_property_id from site_configs if set, else fall back to env var (legacy G2G)
    let ga4Data: {
      weekSessions: number; prevWeekSessions: number; sessionsPct: number | null
      engagedSessions: number; bounceRate: number
      totalConversions: number; prevConversions: number; conversionsPct: number | null
      totalRevenue: number; prevRevenue: number; revenuePct: number | null
      topPages: { pagePath: string; sessions: number; conversions: number; revenue: number }[]
    } | null = null

    const ga4PropertyId = siteConfig.ga4_property_id ?? (siteSlug === 'g2g' ? process.env.GA4_PROPERTY_ID : null)

    try {
      if (conn?.access_token && ga4PropertyId) {
        const ga4Auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
        const [thisWeekRaw, prevWeekRaw, topPagesRaw] = await Promise.all([
          getGA4Report(ga4Auth, ga4PropertyId, weekStart, weekEnd,
            ['date'], ['sessions', 'engagedSessions', 'bounceRate', 'conversions', 'purchaseRevenue'], 7),
          getGA4Report(ga4Auth, ga4PropertyId, prevWeekStart, prevWeekEnd,
            ['date'], ['sessions', 'engagedSessions', 'bounceRate', 'conversions', 'purchaseRevenue'], 7),
          getGA4Report(ga4Auth, ga4PropertyId, weekStart, weekEnd,
            ['pagePath', 'sessionDefaultChannelGroup'], ['sessions', 'conversions', 'purchaseRevenue'], 30),
        ])
        const thisRows = parseGA4Rows(thisWeekRaw)
        const prevRows = parseGA4Rows(prevWeekRaw)
        const topRows  = parseGA4Rows(topPagesRaw)

        const weekSessions     = sumMetric(thisRows, 'sessions')
        const prevSessions     = sumMetric(prevRows, 'sessions')
        const weekEngaged      = sumMetric(thisRows, 'engagedSessions')
        const totalConversions = sumMetric(thisRows, 'conversions')
        const prevConversions  = sumMetric(prevRows, 'conversions')
        const totalRevenue     = thisRows.reduce((s, r) => s + parseFloat(r.purchaseRevenue ?? '0'), 0)
        const prevRevenue      = prevRows.reduce((s, r) => s + parseFloat(r.purchaseRevenue ?? '0'), 0)
        const bounceArr        = thisRows.map(r => parseFloat(r.bounceRate ?? '0')).filter(n => !isNaN(n))
        const avgBounce        = bounceArr.length ? bounceArr.reduce((a, b) => a + b, 0) / bounceArr.length : 0

        const organicPages = topRows
          .filter(r =>
            r.sessionDefaultChannelGroup?.toLowerCase().includes('organic') &&
            (r.pagePath ?? '').includes('/categories/') &&
            !(r.pagePath ?? '').includes('/offer/')
          )
          .map(r => ({
            pagePath:    r.pagePath ?? '',
            sessions:    parseInt(r.sessions ?? '0'),
            conversions: parseInt(r.conversions ?? '0'),
            revenue:     parseFloat(r.purchaseRevenue ?? '0'),
          }))
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 10)

        ga4Data = {
          weekSessions,
          prevWeekSessions: prevSessions,
          sessionsPct:      pctChange(weekSessions, prevSessions),
          engagedSessions:  weekEngaged,
          bounceRate:       +avgBounce.toFixed(2),
          totalConversions,
          prevConversions,
          conversionsPct:   pctChange(totalConversions, prevConversions),
          totalRevenue:     +totalRevenue.toFixed(2),
          prevRevenue:      +prevRevenue.toFixed(2),
          revenuePct:       pctChange(Math.round(totalRevenue), Math.round(prevRevenue)),
          topPages:         organicPages,
        }
      }
    } catch (e) {
      console.warn('[weekly-report] GA4 fetch failed:', e)
    }

    // ── Competitive SoV ──────────────────────────────────────────────────────
    const competitorList = (competitors.data ?? []).map(c => ({ domain: c.domain, name: c.name }))

    let sovTable: { domain: string; sov: number; keywords: number; estimated?: boolean }[] = []
    let sovKeywordCount = 0
    let sovEstimated = false

    try {
      const { data: snapshots } = await supabase
        .from('serp_snapshots')
        .select('keyword, search_volume, results, snapshot_date')
        .eq('owner_user_id', ownerId)
        .gte('snapshot_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
        .order('snapshot_date', { ascending: false })

      if (snapshots && snapshots.length > 0) {
        const latestByKeyword = new Map<string, typeof snapshots[0]>()
        for (const snap of snapshots) {
          if (!latestByKeyword.has(snap.keyword)) latestByKeyword.set(snap.keyword, snap)
        }
        sovKeywordCount = latestByKeyword.size

        const rawSov = new Map<string, number>()
        const kwCount = new Map<string, number>()
        for (const snap of latestByKeyword.values()) {
          const vol = snap.search_volume ?? 0
          const results = (snap.results ?? []) as { domain?: string; rank_absolute?: number }[]
          for (const r of results) {
            if (!r.domain) continue
            const dom = normalizeDomain(r.domain)
            const pos = r.rank_absolute ?? 99
            const ctr = CTR_CURVE[pos] ?? 0
            rawSov.set(dom, (rawSov.get(dom) ?? 0) + ctr * vol)
            kwCount.set(dom, (kwCount.get(dom) ?? 0) + 1)
          }
        }

        const totalRaw = Array.from(rawSov.values()).reduce((a, b) => a + b, 0)
        if (totalRaw > 0) {
          const allDomains = new Set([
            semrushDomain,
            ...competitorList.map(c => normalizeDomain(c.domain)),
          ])
          sovTable = Array.from(allDomains)
            .map(dom => ({
              domain:   dom,
              sov:      Math.round(((rawSov.get(dom) ?? 0) / totalRaw) * 1000) / 10,
              keywords: kwCount.get(dom) ?? 0,
            }))
            .filter(r => r.sov > 0 || r.domain === semrushDomain)
            .sort((a, b) => b.sov - a.sov)
        }
      }
    } catch (e) {
      console.warn('[weekly-report] SoV computation failed:', e)
    }

    // SoV fallback: estimate from SEMrush organic traffic
    if (sovTable.length === 0 && competitorList.length > 0) {
      try {
        const domainsToCheck = [semrushDomain, ...competitorList.slice(0, 4).map(c => normalizeDomain(c.domain))]
        const overviews = await Promise.all(domainsToCheck.map(d => getDomainOverview(d, 'us').catch(() => null)))
        const trafficMap = new Map<string, number>()
        overviews.forEach((ov, i) => { if (ov && ov.organicTraffic > 0) trafficMap.set(domainsToCheck[i], ov.organicTraffic) })
        const totalTraffic = Array.from(trafficMap.values()).reduce((a, b) => a + b, 0)
        if (totalTraffic > 0) {
          sovTable = Array.from(trafficMap.entries())
            .map(([domain, traffic]) => ({
              domain,
              sov: Math.round((traffic / totalTraffic) * 1000) / 10,
              keywords: 0,
              estimated: true,
            }))
            .sort((a, b) => b.sov - a.sov)
          sovEstimated = true
        }
      } catch (e) {
        console.warn('[weekly-report] SEMrush SoV estimation failed:', e)
      }
    }

    const competitiveData = {
      trackedCompetitors: competitorList,
      sovTable,
      sovKeywordCount,
      sovEstimated,
    }

    // ── Base report data ─────────────────────────────────────────────────────
    const baseReportData = {
      weekStart,
      weekEnd,
      gsc: gscData,
      ga4: ga4Data,
      semrush: semrushData,
      actionItems: actionItemsData,
      competitive: competitiveData,
      domainAuthority,
      generatedAt: new Date().toISOString(),
    }

    // ── Generate AI narrative ────────────────────────────────────────────────
    const narrativePrompt = buildNarrativePrompt({
      siteName: siteConfig.display_name,
      siteDomain: semrushDomain,
      weekStart, weekEnd,
      gsc: gscData,
      ga4: ga4Data,
      semrush: semrushData,
      actionItems: actionItemsData,
      competitive: competitiveData,
      domainAuthority,
    })

    let aiNarrative      = ''
    let aiIssues         = ''
    let aiManagementPlan = ''
    let aiTeamPlan       = ''
    let aiActionPlan     = ''

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 2500,
        messages: [{ role: 'user', content: narrativePrompt }],
      })
      const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : ''

      const [part1, rest1] = raw.split(/\n---ISSUES---\n/)
      const [part2, rest2] = (rest1 ?? '').split(/\n---MANAGEMENT_PLAN---\n/)
      const [part3, part4] = (rest2 ?? '').split(/\n---TEAM_PLAN---\n/)

      aiNarrative      = part1?.trim() ?? raw
      aiIssues         = part2?.trim() ?? ''
      aiManagementPlan = part3?.trim() ?? ''
      aiTeamPlan       = part4?.trim() ?? ''
      aiActionPlan     = aiTeamPlan
    } catch (e) {
      console.warn('[weekly-report] AI generation failed:', e)
      aiNarrative = '_AI narrative could not be generated. Check Anthropic API key._'
    }

    const reportData = {
      ...baseReportData,
      aiIssues,
      aiManagementPlan,
      aiTeamPlan,
    }

    // ── Save report ──────────────────────────────────────────────────────────
    const { data: saved, error: saveErr } = await supabase
      .from('weekly_reports')
      .insert({
        owner_user_id:  ownerId,
        site_slug:      siteSlug,
        week_start:     weekStart,
        week_end:       weekEnd,
        report_data:    reportData,
        ai_narrative:   aiNarrative,
        ai_action_plan: aiActionPlan,
      })
      .select()
      .single()

    if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 })
    return NextResponse.json({ report: saved })

  } catch (err: unknown) {
    console.error('[weekly-report] Unhandled POST error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ── DELETE /api/reports/weekly?id=xxx ─────────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('weekly_reports')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── AI Prompt ─────────────────────────────────────────────────────────────────
function buildNarrativePrompt(d: {
  siteName: string
  siteDomain: string
  weekStart: string; weekEnd: string
  gsc: {
    weekClicks: number; prevWeekClicks: number; clicksPct: number | null
    weekImpressions: number; weekCtr: number; prevWeekCtr: number; avgPosition: number
    topGainers: { page: string; delta: number }[]
    topDroppers: { page: string; delta: number }[]
  }
  ga4: {
    weekSessions: number; prevWeekSessions: number; sessionsPct: number | null
    bounceRate: number
    totalConversions: number; prevConversions: number; conversionsPct: number | null
    totalRevenue: number; prevRevenue: number; revenuePct: number | null
  } | null
  semrush: { totalKeywords: number; top3: number; top10: number; topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]; topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[] }
  actionItems: { total: number; pending: number; inProgress: number; done: number; assignedThisWeek: number; completedThisWeek: number }
  competitive: { trackedCompetitors: { domain: string; name?: string }[] }
  domainAuthority?: { organicKeywords: number; organicTraffic: number; organicCost: number } | null
}): string {
  const siteOrigin = `https://www.${d.siteDomain}`
  const fmtUrl = (url: string) => url.replace(siteOrigin, '').replace(`https://${d.siteDomain}`, '') || '/'
  const fmtUsd = (n: number) => n > 0 ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '$0'
  const gainers  = d.gsc.topGainers.map(g => `  • ${fmtUrl(g.page)} (+${g.delta} clicks)`).join('\n') || '  None'
  const droppers = d.gsc.topDroppers.map(g => `  • ${fmtUrl(g.page)} (${g.delta} clicks)`).join('\n') || '  None'
  const kwUp     = d.semrush.topMoversUp.slice(0, 5).map(k => `  • "${k.keyword}" pos ${k.position} (↑${k.positionDiff})`).join('\n') || '  None'
  const kwDown   = d.semrush.topMoversDown.slice(0, 5).map(k => `  • "${k.keyword}" pos ${k.position} (↓${Math.abs(k.positionDiff)})`).join('\n') || '  None'
  const competitors = d.competitive.trackedCompetitors.map(c => c.domain).join(', ') || 'none tracked'
  const pctStr = (v: number | null) => v != null ? `${v > 0 ? '+' : ''}${v}%` : 'n/a'
  const daSection = d.domainAuthority
    ? `Domain Authority (SEMrush estimate):
- Organic keywords: ${d.domainAuthority.organicKeywords.toLocaleString()}
- Est. organic traffic: ${d.domainAuthority.organicTraffic.toLocaleString()}/mo
- Est. traffic value: ${fmtUsd(d.domainAuthority.organicCost)}/mo`
    : ''

  return `You are an expert SEO strategist analyzing weekly performance data for ${d.siteName} (${d.siteDomain}) — a gaming marketplace primarily targeting the US market.

Analyze the following weekly SEO data (${d.weekStart} to ${d.weekEnd}) and write exactly 4 sections in this order:

1. NARRATIVE (3–4 paragraphs): explain what happened, WHY metrics moved, key risks and opportunities. Use actual numbers. Be direct.
2. ISSUES & SHORTCOMINGS (3–5 bullet points): specific problems, risks, or gaps — things that are broken or underperforming.
3. MANAGEMENT BRIEF (3 items): strategic priorities for leadership — budget decisions, resource allocation, competitive risks, revenue impact.
4. INTERNAL TEAM PLAN (5 items): tactical tasks for the SEO/content team — what exactly to do, in what order, why.

DATA:
GSC Performance:
- Clicks: ${d.gsc.weekClicks.toLocaleString()} (prev: ${d.gsc.prevWeekClicks.toLocaleString()}, ${pctStr(d.gsc.clicksPct)})
- Impressions: ${d.gsc.weekImpressions.toLocaleString()}
- CTR: ${d.gsc.weekCtr}% (prev: ${d.gsc.prevWeekCtr}%)
- Avg position: ${d.gsc.avgPosition}
Top gaining pages:
${gainers}
Top dropping pages:
${droppers}

${d.ga4 ? `GA4 Performance:
- Organic sessions: ${d.ga4.weekSessions.toLocaleString()} (prev: ${d.ga4.prevWeekSessions.toLocaleString()}, ${pctStr(d.ga4.sessionsPct)})
- Conversions: ${d.ga4.totalConversions.toLocaleString()} (prev: ${d.ga4.prevConversions.toLocaleString()}, ${pctStr(d.ga4.conversionsPct)})
- Revenue: ${fmtUsd(d.ga4.totalRevenue)} (prev: ${fmtUsd(d.ga4.prevRevenue)}, ${pctStr(d.ga4.revenuePct)})
- Bounce rate: ${(d.ga4.bounceRate * 100).toFixed(1)}%` : 'GA4: Not connected for this site'}

SEMrush Keywords:
- Total tracked: ${d.semrush.totalKeywords.toLocaleString()}
- Top 3: ${d.semrush.top3} | Top 10: ${d.semrush.top10}
Keywords rising:
${kwUp}
Keywords falling:
${kwDown}

${daSection}

Action Items:
- Open: ${d.actionItems.pending + d.actionItems.inProgress} | Completed: ${d.actionItems.done}
- Assigned this week: ${d.actionItems.assignedThisWeek} | Completed this week: ${d.actionItems.completedThisWeek}

Tracked competitors: ${competitors}

FORMAT YOUR RESPONSE EXACTLY LIKE THIS (use these exact marker lines):

[3–4 paragraph narrative here]

---ISSUES---
• [Issue 1]
• [Issue 2]
• [Issue 3]
(add up to 5 bullets total)

---MANAGEMENT_PLAN---
1. **[Strategic priority title]** — [1-2 sentence explanation for leadership]
2. **[Strategic priority title]** — [explanation]
3. **[Strategic priority title]** — [explanation]

---TEAM_PLAN---
1. **[Task title]** — [tactical explanation for SEO/content team]
2. **[Task title]** — [explanation]
3. **[Task title]** — [explanation]
4. **[Task title]** — [explanation]
5. **[Task title]** — [explanation]`
}
