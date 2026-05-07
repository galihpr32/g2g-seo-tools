import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { getDomainKeywords, getDomainOverview } from '@/lib/semrush/client'
import { getAgentInsights, formatInsightsForPrompt } from '@/lib/reports/agent-insights'
import { fetchChannelBreakdown } from '@/lib/reports/channel-breakdown'
import { analyzeTrackedRankings } from '@/lib/reports/ranking-analysis'
import { getRefreshedClient } from '@/lib/gsc/auth'
import { getSearchAnalytics } from '@/lib/gsc/client'
import { getGA4Report, parseGA4Rows, sumMetric } from '@/lib/ga4/client'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Date helpers ──────────────────────────────────────────────────────────────

function getMonthRange(year: number, month: number) {
  // month: 1-12
  const start = new Date(year, month - 1, 1)
  const end   = new Date(year, month, 0) // last day
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { start: fmt(start), end: fmt(end) }
}

function getPreviousMonth(year: number, month: number) {
  const d = new Date(year, month - 1, 1)
  d.setMonth(d.getMonth() - 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1 }
}

function monthLabel(year: number, month: number) {
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function pctChange(current: number, prev: number): number | null {
  if (!prev) return null
  return Math.round(((current - prev) / prev) * 100)
}

// ── GET — list or fetch single ────────────────────────────────────────────────

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { searchParams } = new URL(req.url)
  const id   = searchParams.get('id')
  const site = searchParams.get('site') ?? 'g2g'

  if (id) {
    const { data, error } = await db
      .from('monthly_reports')
      .select('*')
      .eq('id', id)
      .eq('owner_user_id', ownerId)
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ report: data })
  }

  const { data, error } = await db
    .from('monthly_reports')
    .select('id, month_start, month_end, created_at, ai_narrative, site_slug')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', site)
    .order('month_start', { ascending: false })
    .limit(24)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data ?? [] })
}

// ── POST — generate a new monthly report ──────────────────────────────────────
// Body: { year?: number, month?: number }  defaults to last complete calendar month

export async function POST(req: Request) {
  const body = await req.clone().json().catch(() => ({}))
  const db   = createServiceClient()

  // Auth: user session OR Bearer ${CRON_SECRET} (cron mode = body.owner_user_id)
  const authHeader = req.headers.get('authorization')
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`

  let ownerId: string
  if (isCron) {
    if (!body.owner_user_id || typeof body.owner_user_id !== 'string') {
      return NextResponse.json({ error: 'Cron mode requires body.owner_user_id' }, { status: 400 })
    }
    ownerId = body.owner_user_id as string
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ownerId = await getEffectiveOwnerId(supabase, user.id)
  }

  // Resolve site_config so SEMrush domain & display name match weekly's behaviour.
  // Defaults to 'g2g' for back-compat (existing reports always assumed g2g).
  const siteSlug   = (body.site as string | undefined) ?? 'g2g'
  const { data: siteConfig } = await db
    .from('site_configs')
    .select('slug, display_name, semrush_domain, gsc_property, ga4_property_id, favicon_domain')
    .eq('slug', siteSlug)
    .maybeSingle()
  const semrushDomain = siteConfig?.semrush_domain  ?? 'g2g.com'
  const siteDisplay   = siteConfig?.display_name    ?? 'G2G'
  const faviconDomain = siteConfig?.favicon_domain  ?? 'g2g.com'

  // Default to last complete month
  const now = new Date()
  const defaultYear  = body.year  ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())
  const defaultMonth = body.month ?? (now.getMonth() === 0 ? 12 : now.getMonth())

  const targetYear  = defaultYear  as number
  const targetMonth = defaultMonth as number

  const { start: monthStart, end: monthEnd } = getMonthRange(targetYear, targetMonth)
  const { year: prevYear, month: prevMonth } = getPreviousMonth(targetYear, targetMonth)
  const { start: prevStart, end: prevEnd }   = getMonthRange(prevYear, prevMonth)

  // Delete and regenerate if already exists (scoped to this site)
  const { data: existing } = await db
    .from('monthly_reports')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('month_start', monthStart)
    .maybeSingle()
  if (existing) {
    await db.from('monthly_reports').delete().eq('id', existing.id)
  }

  // GSC connection — tokens are shared across sites (same Google account).
  // Use siteConfig.gsc_property as the GSC property URL (not conn.site_url which
  // reflects whichever property was last selected during OAuth). This matches
  // the weekly report pattern and ensures OG queries OG's GSC property.
  const { data: conn } = await db
    .from('gsc_connections')
    .select('site_url, access_token, refresh_token, expires_at')
    .eq('user_id', ownerId)
    .maybeSingle()

  // Sprint 12 fix: NO fallback to gsc_connections.site_url — that legacy
  // path always returned G2G's URL (single OAuth row per user), causing
  // OffGamers monthly reports to render G2G data.
  const siteUrl = siteConfig?.gsc_property ?? null

  // ── Fetch action items + competitors + backlinks (in parallel; GSC fetched
  // separately below from the live API because the snapshot table is a
  // 7-day-rolling-window trend cache, not a daily aggregate, so summing it
  // over a month overcounts AND truncates at 1000 rows) ────────────────────
  const [
    actionItemsRes,
    competitorsRes,
    backlinksRes,
  ] = await Promise.all([
    siteUrl
      ? db
          .from('seo_action_items')
          .select('id, status, assigned_to, created_at, completed_at, action_type')
          .eq('site_url', siteUrl)
          .gte('created_at', monthStart)
          .lte('created_at', monthEnd + 'T23:59:59')
      : Promise.resolve({ data: [] }),

    db
      .from('competitors')
      .select('domain, name, active')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .eq('active', true)
      .limit(5),

    // Paid backlinks — all active, plus those acquired this month, scoped
    // to the active brand so OG reports don't pull G2G's backlink portfolio.
    db
      .from('paid_backlinks')
      .select('id, site_name, external_url, anchor_text, target_page, target_keyword, link_status, live_date, cost_amount, cost_currency, position_current, position_at_creation')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug),
  ])

  // ── Fetch GSC monthly aggregates DIRECTLY from live API ──────────────────
  // The previous snapshot-based path was wrong on two axes:
  //   1. gsc-daily upserts 7-day-window aggregates per (site, page, today) →
  //      summing 30 daily rows = ~7x overcount on each page.
  //   2. PostgREST default max-rows=1000 truncated 30k+ row queries to <3%
  //      sample → severe undercount.
  //   Net visible effect: April reported 247K clicks vs GSC truth 1.63M.
  // GSC API is the source of truth — call it directly with rowLimit=5000
  // (covers >99% of clicks for typical sites; GSC API caps at 25k).
  let curSnaps:  Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number; snapshot_date: string }> = []
  let prevSnaps: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number; snapshot_date: string }> = []

  if (conn?.access_token && siteUrl) {
    try {
      const gscAuth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
      const [curRows, prevRows] = await Promise.all([
        getSearchAnalytics(gscAuth, siteUrl, monthStart, monthEnd, ['page'], 5000),
        getSearchAnalytics(gscAuth, siteUrl, prevStart,  prevEnd,  ['page'], 5000),
      ])
      curSnaps = curRows.map(r => ({
        page:          r.keys?.[0] ?? '',
        clicks:        r.clicks ?? 0,
        impressions:   r.impressions ?? 0,
        ctr:           r.ctr ?? 0,
        position:      r.position ?? 0,
        snapshot_date: monthEnd,
      }))
      prevSnaps = prevRows.map(r => ({
        page:          r.keys?.[0] ?? '',
        clicks:        r.clicks ?? 0,
        impressions:   r.impressions ?? 0,
        ctr:           r.ctr ?? 0,
        position:      r.position ?? 0,
        snapshot_date: prevEnd,
      }))
    } catch (e) {
      console.warn('[monthly-report] GSC live API failed:', e)
    }
  }

  // Last-resort fallback: snapshot table (only if we have NO live access).
  // Acknowledges the snapshot data is approximate (overcount + truncated)
  // but better than nothing.
  if (curSnaps.length === 0 && siteUrl) {
    const { data } = await db
      .from('gsc_ranking_snapshots')
      .select('page, clicks, impressions, ctr, position, snapshot_date')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', monthStart)
      .lte('snapshot_date', monthEnd)
      .limit(5000)
    curSnaps = (data ?? []) as typeof curSnaps
  }
  if (prevSnaps.length === 0 && siteUrl) {
    const { data } = await db
      .from('gsc_ranking_snapshots')
      .select('page, clicks, impressions, ctr, position, snapshot_date')
      .eq('site_url', siteUrl)
      .gte('snapshot_date', prevStart)
      .lte('snapshot_date', prevEnd)
      .limit(5000)
    prevSnaps = (data ?? []) as typeof prevSnaps
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

  // Top page movers
  const pageMovers: { page: string; curClicks: number; prevClicks: number; delta: number }[] = []
  for (const [page, c] of cur.pageMap.entries()) {
    const p = prev.pageMap.get(page) ?? { clicks: 0, impressions: 0 }
    pageMovers.push({ page, curClicks: c.clicks, prevClicks: p.clicks, delta: c.clicks - p.clicks })
  }
  pageMovers.sort((a, b) => b.delta - a.delta)
  const topGainers = pageMovers.slice(0, 8).filter(p => p.delta > 0)
  const topDroppers = pageMovers.slice(-8).reverse().filter(p => p.delta < 0)

  // Top pages by clicks this month
  const topPagesByClicks = Array.from(cur.pageMap.entries())
    .map(([page, c]) => ({ page, clicks: c.clicks, impressions: c.impressions }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)

  const gscData = {
    monthClicks:         cur.clicks,
    prevMonthClicks:     prev.clicks,
    clicksPct:           pctChange(cur.clicks, prev.clicks),
    monthImpressions:    cur.impressions,
    prevImpressions:     prev.impressions,
    impressionsPct:      pctChange(cur.impressions, prev.impressions),
    monthCtr:            cur.ctr,
    prevCtr:             prev.ctr,
    ctrPct:              pctChange(Math.round(cur.ctr * 100), Math.round(prev.ctr * 100)),
    avgPosition:         cur.avgPosition,
    totalUniquePages:    cur.pageMap.size,
    topGainers:          topGainers.map(p => ({ page: p.page, delta: p.delta, clicks: p.curClicks })),
    topDroppers:         topDroppers.map(p => ({ page: p.page, delta: p.delta, clicks: p.curClicks })),
    topPagesByClicks,
  }

  // ── Action items this month ─────────────────────────────────────────────────
  const monthItems = actionItemsRes.data ?? []
  const actionItemsData = {
    total:     monthItems.length,
    pending:   monthItems.filter(i => i.status === 'pending').length,
    inProgress: monthItems.filter(i => i.status === 'in_progress').length,
    done:      monthItems.filter(i => i.status === 'done').length,
  }

  // ── Paid Backlinks ────────────────────────────────────────────────────────────
  const allBacklinks = backlinksRes.data ?? []
  const activeBacklinks = allBacklinks.filter(b => b.link_status === 'active')

  // Acquired this month (live_date within monthStart..monthEnd)
  const newThisMonth = allBacklinks.filter(b => {
    if (!b.live_date) return false
    return b.live_date >= monthStart && b.live_date <= monthEnd
  })

  // Group costs by currency to avoid mixing IDR with USD
  const costsByCurrency: Record<string, number> = {}
  for (const b of newThisMonth) {
    if (!b.cost_amount) continue
    const cur = (b.cost_currency ?? 'USD').toUpperCase()
    costsByCurrency[cur] = (costsByCurrency[cur] ?? 0) + parseFloat(String(b.cost_amount))
  }
  const totalCostThisMonth = costsByCurrency['USD'] ?? 0 // legacy field — USD only for backward compat

  const allTimeCostsByCurrency: Record<string, number> = {}
  for (const b of activeBacklinks) {
    if (!b.cost_amount) continue
    const cur = (b.cost_currency ?? 'USD').toUpperCase()
    allTimeCostsByCurrency[cur] = (allTimeCostsByCurrency[cur] ?? 0) + parseFloat(String(b.cost_amount))
  }
  const totalCostAllTime = allTimeCostsByCurrency['USD'] ?? 0

  // Compute average position improvement for active links that have both positions
  const linksWithImprovement = activeBacklinks.filter(
    b => b.position_current != null && b.position_at_creation != null
  )
  const avgPositionImprovement = linksWithImprovement.length > 0
    ? +(linksWithImprovement.reduce((sum, b) =>
        sum + ((b.position_at_creation ?? 0) - (b.position_current ?? 0)), 0
      ) / linksWithImprovement.length).toFixed(1)
    : null

  const backlinksData = {
    totalActive:              activeBacklinks.length,
    newThisMonth:             newThisMonth.length,
    pendingLinks:             allBacklinks.filter(b => b.link_status === 'pending').length,
    brokenLinks:              allBacklinks.filter(b => b.link_status === 'broken').length,
    totalCostThisMonth:       +totalCostThisMonth.toFixed(2),   // USD only (legacy compat)
    totalCostAllTime:         +totalCostAllTime.toFixed(2),      // USD only (legacy compat)
    costsByCurrency:          Object.entries(costsByCurrency).map(([currency, total]) => ({ currency, total: +total.toFixed(2) })),
    allTimeCostsByCurrency:   Object.entries(allTimeCostsByCurrency).map(([currency, total]) => ({ currency, total: +total.toFixed(2) })),
    avgPositionImprovement,
    recentLinks: newThisMonth
      .sort((a, b) => (b.live_date ?? '').localeCompare(a.live_date ?? ''))
      .slice(0, 8)
      .map(b => ({
        siteName:           b.site_name,
        externalUrl:        b.external_url,
        anchorText:         b.anchor_text,
        targetPage:         b.target_page,
        targetKeyword:      b.target_keyword ?? null,
        liveDate:           b.live_date ?? null,
        costAmount:         b.cost_amount ? parseFloat(String(b.cost_amount)) : null,
        costCurrency:       (b.cost_currency ?? 'USD').toUpperCase(),
        positionCurrent:    b.position_current ?? null,
        positionAtCreation: b.position_at_creation ?? null,
      })),
  }

  // ── SEMrush keywords ─────────────────────────────────────────────────────────
  let semrushData: {
    totalKeywords: number; top3: number; top10: number; top20: number
    avgPosition: number
    topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]
    topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[]
    organicTraffic: number
  } = { totalKeywords: 0, top3: 0, top10: 0, top20: 0, avgPosition: 0, topMoversUp: [], topMoversDown: [], organicTraffic: 0 }

  try {
    const [keywords, overview] = await Promise.all([
      getDomainKeywords(semrushDomain, 'us', 500),
      getDomainOverview(semrushDomain, 'us'),
    ])
    const up   = keywords.filter(k => k.positionDiff < 0).sort((a, b) => a.positionDiff - b.positionDiff).slice(0, 10)
    const down = keywords.filter(k => k.positionDiff > 0).sort((a, b) => b.positionDiff - a.positionDiff).slice(0, 10)
    const posSum = keywords.reduce((s, k) => s + k.position, 0)
    semrushData = {
      totalKeywords:   keywords.length,
      top3:            keywords.filter(k => k.position <= 3).length,
      top10:           keywords.filter(k => k.position <= 10).length,
      top20:           keywords.filter(k => k.position <= 20).length,
      avgPosition:     keywords.length ? +(posSum / keywords.length).toFixed(1) : 0,
      organicTraffic:  overview?.organicTraffic ?? 0,
      topMoversUp:     up.map(k => ({ keyword: k.keyword, position: k.position, positionDiff: k.positionDiff, volume: k.searchVolume })),
      topMoversDown:   down.map(k => ({ keyword: k.keyword, position: k.position, positionDiff: k.positionDiff, volume: k.searchVolume })),
    }
  } catch (e) {
    console.warn('[monthly-report] SEMrush fetch failed:', e)
  }

  // ── GA4 ──────────────────────────────────────────────────────────────────────
  let ga4Data: {
    monthSessions: number; prevSessions: number; sessionsPct: number | null
    engagedSessions: number; bounceRate: number
    totalConversions: number; prevConversions: number; conversionsPct: number | null
    totalRevenue: number; prevRevenue: number; revenuePct: number | null
    topPages: { pagePath: string; sessions: number; conversions: number; revenue: number }[]
  } | null = null

  try {
    if (conn?.access_token) {
      // Prefer site_configs.ga4_property_id (per-site), fall back to env var (G2G legacy)
      const ga4PropertyId = siteConfig?.ga4_property_id ?? process.env.GA4_PROPERTY_ID
      if (ga4PropertyId) {
        const ga4Auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
        const [thisMonthRaw, prevMonthRaw, topPagesRaw, topPagesPrevRaw] = await Promise.all([
          getGA4Report(ga4Auth, ga4PropertyId, monthStart, monthEnd,
            ['date'], ['sessions', 'engagedSessions', 'bounceRate', 'conversions', 'purchaseRevenue'], 31),
          getGA4Report(ga4Auth, ga4PropertyId, prevStart, prevEnd,
            ['date'], ['sessions', 'engagedSessions', 'bounceRate', 'conversions', 'purchaseRevenue'], 31),
          getGA4Report(ga4Auth, ga4PropertyId, monthStart, monthEnd,
            ['pagePath', 'sessionDefaultChannelGroup'], ['sessions', 'conversions', 'purchaseRevenue'], 50),
          // Prev-month version of the SAME query — drives the "vs Last Month"
          // delta column on slide 6 + the report viewer's top-pages table.
          getGA4Report(ga4Auth, ga4PropertyId, prevStart, prevEnd,
            ['pagePath', 'sessionDefaultChannelGroup'], ['sessions', 'conversions', 'purchaseRevenue'], 50),
        ])
        const thisRows    = parseGA4Rows(thisMonthRaw)
        const prevRows    = parseGA4Rows(prevMonthRaw)
        const topRows     = parseGA4Rows(topPagesRaw)
        const topPrevRows = parseGA4Rows(topPagesPrevRaw)

        const monthSessions     = sumMetric(thisRows, 'sessions')
        const prevSessions      = sumMetric(prevRows, 'sessions')
        const weekEngaged       = sumMetric(thisRows, 'engagedSessions')
        const totalConversions  = sumMetric(thisRows, 'conversions')
        const prevConversions   = sumMetric(prevRows, 'conversions')
        const totalRevenue      = thisRows.reduce((s, r) => s + parseFloat(r.purchaseRevenue ?? '0'), 0)
        const prevRevenue       = prevRows.reduce((s, r) => s + parseFloat(r.purchaseRevenue ?? '0'), 0)
        const bounceArr         = thisRows.map(r => parseFloat(r.bounceRate ?? '0')).filter(n => !isNaN(n))
        const avgBounce         = bounceArr.length ? bounceArr.reduce((a, b) => a + b, 0) / bounceArr.length : 0

        // Build prev-month sessions index for "vs Last Month" delta column.
        // Same channel-filter as current month so we compare like-for-like
        // (organic /categories/ traffic both sides).
        const prevByPage = new Map<string, number>()
        for (const r of topPrevRows) {
          if (!r.sessionDefaultChannelGroup?.toLowerCase().includes('organic')) continue
          const path = r.pagePath ?? ''
          if (!path.includes('/categories/') || path.includes('/offer/')) continue
          prevByPage.set(path, (prevByPage.get(path) ?? 0) + parseInt(r.sessions ?? '0'))
        }

        const organicPages = topRows
          .filter(r =>
            r.sessionDefaultChannelGroup?.toLowerCase().includes('organic') &&
            (r.pagePath ?? '').includes('/categories/') &&
            !(r.pagePath ?? '').includes('/offer/')
          )
          .map(r => {
            const path     = r.pagePath ?? ''
            const sessions = parseInt(r.sessions ?? '0')
            const prev     = prevByPage.get(path) ?? 0
            return {
              pagePath:        path,
              sessions,
              conversions:     parseInt(r.conversions ?? '0'),
              revenue:         parseFloat(r.purchaseRevenue ?? '0'),
              prevSessions:    prev,
              sessionsPct:     pctChange(sessions, prev),    // null when prev=0 → "NEW" badge
            }
          })
          .sort((a, b) => b.sessions - a.sessions)
          .slice(0, 15)

        ga4Data = {
          monthSessions,
          prevSessions,
          sessionsPct:     pctChange(monthSessions, prevSessions),
          engagedSessions: weekEngaged,
          bounceRate:      +avgBounce.toFixed(2),
          totalConversions,
          prevConversions,
          conversionsPct:  pctChange(totalConversions, prevConversions),
          totalRevenue:    +totalRevenue.toFixed(2),
          prevRevenue:     +prevRevenue.toFixed(2),
          revenuePct:      pctChange(Math.round(totalRevenue), Math.round(prevRevenue)),
          topPages:        organicPages,
        }
      }
    }
  } catch (e) {
    console.warn('[monthly-report] GA4 fetch failed:', e)
  }

  // ── Competitive SoV ─────────────────────────────────────────────────────────
  const CTR_CURVE: Record<number, number> = {
    1: 0.284, 2: 0.146, 3: 0.099, 4: 0.073, 5: 0.057,
    6: 0.045, 7: 0.036, 8: 0.029, 9: 0.023, 10: 0.019,
  }
  function normalizeDomain(d: string) { return d.replace(/^www\./, '').toLowerCase() }

  const competitorList = (competitorsRes.data ?? []).map(c => ({ domain: c.domain, name: c.name }))
  let sovTable: { domain: string; sov: number; keywords: number }[] = []

  let sovEstimated = false   // true when we fall back to outside the target month
  try {
    let { data: snapshots } = await db
      .from('serp_snapshots')
      .select('keyword, search_volume, results, snapshot_date')
      .eq('owner_user_id', ownerId)
      .gte('snapshot_date', monthStart)
      .lte('snapshot_date', monthEnd)
      .order('snapshot_date', { ascending: false })

    // Fallback: if no snapshots inside the target month, look at the most
    // recent 60 days from the report's monthEnd. This handles the very
    // common case where a user just started SERP tracking — the data
    // arrives stamped with TODAY but the user's looking at last month's
    // report, so without this fallback they'd see "No SERP data" forever.
    // We tag the result as `estimated: true` so the UI can show a hint.
    if (!snapshots || snapshots.length === 0) {
      const fallbackStart = new Date(new Date(monthEnd).getTime() - 60 * 86400000)
        .toISOString().slice(0, 10)
      const { data: fallback } = await db
        .from('serp_snapshots')
        .select('keyword, search_volume, results, snapshot_date')
        .eq('owner_user_id', ownerId)
        .gte('snapshot_date', fallbackStart)
        .order('snapshot_date', { ascending: false })
      if (fallback && fallback.length > 0) {
        snapshots = fallback
        sovEstimated = true
        console.info(`[monthly-report] no snapshots in ${monthStart}..${monthEnd}; using ${fallback.length} from past 60d as estimate`)
      }
    }

    if (snapshots && snapshots.length > 0) {
      const latestByKeyword = new Map<string, typeof snapshots[0]>()
      for (const snap of snapshots) {
        if (!latestByKeyword.has(snap.keyword)) latestByKeyword.set(snap.keyword, snap)
      }

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
        const primaryDomain = normalizeDomain(faviconDomain)  // 'g2g.com' or 'offgamers.com'
        const allDomains = new Set([primaryDomain, ...competitorList.map(c => normalizeDomain(c.domain))])
        sovTable = Array.from(allDomains)
          .map(dom => ({
            domain:   dom,
            sov:      Math.round(((rawSov.get(dom) ?? 0) / totalRaw) * 1000) / 10,
            keywords: kwCount.get(dom) ?? 0,
          }))
          .filter(r => r.sov > 0 || r.domain === primaryDomain)
          .sort((a, b) => b.sov - a.sov)
      }
    }
  } catch (e) {
    console.warn('[monthly-report] SoV failed:', e)
  }

  // ── Agent insights ───────────────────────────────────────────────────────
  const agentInsights = await getAgentInsights(db, ownerId, monthStart, monthEnd, siteSlug)
    .catch(e => {
      console.warn('[monthly-report] agent insights failed:', e)
      return null
    })

  // ── Channel breakdown (GA4 sessionDefaultChannelGroup) ──────────────────
  // Pulls organic / direct / referral / social / paid / email separately so
  // execs can see WHICH channel grew or shrank. Skipped silently if GA4 is
  // unreachable.
  let channelBreakdown: Awaited<ReturnType<typeof fetchChannelBreakdown>> = null
  try {
    if (conn?.access_token) {
      const ga4PropertyId = siteConfig?.ga4_property_id ?? process.env.GA4_PROPERTY_ID
      if (ga4PropertyId) {
        const ga4Auth = await getRefreshedClient(conn.access_token, conn.refresh_token, conn.expires_at)
        channelBreakdown = await fetchChannelBreakdown({
          auth:       ga4Auth,
          propertyId: ga4PropertyId,
          curStart:   monthStart,
          curEnd:     monthEnd,
          prevStart:  prevStart,
          prevEnd:    prevEnd,
        })
      }
    }
  } catch (e) {
    console.warn('[monthly-report] channel breakdown failed:', e)
  }

  // ── Tracked-product ranking analysis (DataForSEO history) ──────────────
  // Site-isolated via site_slug — G2G & OG never cross-pollinate. AI action
  // plan only fires monthly (cost-control); weekly route also calls this with
  // withActionPlan=false.
  let trackedRankings: Awaited<ReturnType<typeof analyzeTrackedRankings>> | null = null
  try {
    trackedRankings = await analyzeTrackedRankings({
      db,
      ownerId,
      siteSlug,
      siteName:    siteDisplay,
      domain:      faviconDomain,
      periodStart: monthStart,
      periodEnd:   monthEnd,
      periodDays:  30,
      withActionPlan: true,
    })
  } catch (e) {
    console.warn('[monthly-report] tracked rankings analysis failed:', e)
  }

  // ── Experiments active during this period ──────────────────────────────
  // Pull start/continue/stop rows for the period_started == this month + any
  // 'continue' rolling forward. The viewer + PPTX render this as a Kanban
  // snapshot so execs see the current bet portfolio.
  const periodKey = `${targetYear}-${String(targetMonth).padStart(2, '0')}`
  const { data: experimentsRows } = await db
    .from('experiments')
    .select('id, title, hypothesis, category, status, period_started, period_ended, success_metric, baseline_value, target_value, current_value, linked_keywords, linked_pages, decision_notes, outcome, source')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .or(`period_started.eq.${periodKey},period_ended.eq.${periodKey},status.eq.continue`)
    .order('updated_at', { ascending: false })
    .limit(40)

  const experimentsData = {
    period:    periodKey,
    start:     (experimentsRows ?? []).filter(e => e.status === 'start'    && e.period_started === periodKey),
    continue:  (experimentsRows ?? []).filter(e => e.status === 'continue'),
    stop:      (experimentsRows ?? []).filter(e => e.status === 'stop'     && e.period_ended  === periodKey),
  }

  // ── Assemble report_data ─────────────────────────────────────────────────────
  const reportData = {
    monthStart,
    monthEnd,
    monthLabel: monthLabel(targetYear, targetMonth),
    prevMonthLabel: monthLabel(prevYear, prevMonth),
    siteSlug,
    siteName: siteDisplay,
    gsc: gscData,
    ga4: ga4Data,
    semrush: semrushData,
    actionItems: actionItemsData,
    competitive: { trackedCompetitors: competitorList, sovTable, sovEstimated },
    backlinks: backlinksData,
    channelBreakdown,
    trackedRankings,
    experiments: experimentsData,
    agentInsights,
    generatedAt: new Date().toISOString(),
  }

  // ── AI narrative ─────────────────────────────────────────────────────────────
  const narrativePrompt = buildNarrativePrompt(reportData)
  let aiNarrative = ''
  let aiActionPlan = ''

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: narrativePrompt }],
    })
    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text : ''
    const [narrativePart, actionPart] = raw.split(/\n---ACTION_PLAN---\n/)
    aiNarrative  = narrativePart?.trim() ?? raw
    aiActionPlan = actionPart?.trim() ?? ''
  } catch (e) {
    console.warn('[monthly-report] AI generation failed:', e)
    aiNarrative  = '_AI narrative could not be generated. Check Anthropic API key._'
    aiActionPlan = ''
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  const { data: saved, error: saveErr } = await db
    .from('monthly_reports')
    .insert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      month_start:    monthStart,
      month_end:      monthEnd,
      report_data:    reportData,
      ai_narrative:   aiNarrative,
      ai_action_plan: aiActionPlan,
    })
    .select()
    .single()

  if (saveErr) return NextResponse.json({ error: saveErr.message }, { status: 500 })
  return NextResponse.json({ report: saved })
}

// ── DELETE ────────────────────────────────────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await db
    .from('monthly_reports')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── AI Prompt ─────────────────────────────────────────────────────────────────
function buildNarrativePrompt(d: {
  monthStart: string; monthEnd: string; monthLabel: string; prevMonthLabel: string
  gsc: {
    monthClicks: number; prevMonthClicks: number; clicksPct: number | null
    monthImpressions: number; monthCtr: number; prevCtr: number; avgPosition: number
    topGainers: { page: string; delta: number }[]
    topDroppers: { page: string; delta: number }[]
  }
  ga4: {
    monthSessions: number; prevSessions: number; sessionsPct: number | null
    bounceRate: number
    totalConversions: number; prevConversions: number; conversionsPct: number | null
    totalRevenue: number; prevRevenue: number; revenuePct: number | null
  } | null
  semrush: {
    totalKeywords: number; top3: number; top10: number; top20: number
    avgPosition: number; organicTraffic: number
    topMoversUp: { keyword: string; position: number; positionDiff: number; volume: number }[]
    topMoversDown: { keyword: string; position: number; positionDiff: number; volume: number }[]
  }
  actionItems: { total: number; pending: number; inProgress: number; done: number }
  competitive: { trackedCompetitors: { domain: string; name?: string }[]; sovTable: { domain: string; sov: number }[] }
  backlinks: {
    totalActive: number; newThisMonth: number; pendingLinks: number; brokenLinks: number
    totalCostThisMonth: number; totalCostAllTime: number; avgPositionImprovement: number | null
  }
  agentInsights?: { windowStart: string; windowEnd: string } | null
  siteName?: string
}): string {
  const agentInsightsBlock = d.agentInsights
    ? formatInsightsForPrompt(d.agentInsights as Parameters<typeof formatInsightsForPrompt>[0])
    : ''
  const fmtUrl = (url: string) => url.replace('https://www.g2g.com', '').replace('https://g2g.com', '') || '/'
  const fmtUsd = (n: number) => n >= 1_000_000 ? `$${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n/1_000).toFixed(0)}K` : `$${Math.round(n)}`
  const pctStr = (v: number | null) => v != null ? `${v > 0 ? '+' : ''}${v}%` : 'n/a'
  const gainers  = d.gsc.topGainers.slice(0, 6).map(g => `  • ${fmtUrl(g.page)} (+${g.delta} clicks)`).join('\n') || '  None'
  const droppers = d.gsc.topDroppers.slice(0, 6).map(g => `  • ${fmtUrl(g.page)} (${g.delta} clicks)`).join('\n') || '  None'
  const kwUp     = d.semrush.topMoversUp.slice(0, 6).map(k => `  • "${k.keyword}" pos ${k.position} (improved ${Math.abs(k.positionDiff)} places)`).join('\n') || '  None'
  const kwDown   = d.semrush.topMoversDown.slice(0, 6).map(k => `  • "${k.keyword}" pos ${k.position} (dropped ${k.positionDiff} places)`).join('\n') || '  None'
  const sov      = d.competitive.sovTable.slice(0, 5).map(s => `  • ${s.domain}: ${s.sov}%`).join('\n') || '  No data'
  const competitors = d.competitive.trackedCompetitors.map(c => c.domain).join(', ') || 'none tracked'

  return `You are an expert SEO strategist writing a monthly performance report for ${d.siteName ?? 'G2G.com'} — a gaming marketplace (gift cards, game items, top-up) primarily targeting the US market.

Analyze the following data for ${d.monthLabel} (vs ${d.prevMonthLabel}) and write:
1. A comprehensive executive narrative (4–5 paragraphs) covering:
   - Overall organic performance summary (with numbers)
   - Revenue and conversion analysis
   - Keyword ranking wins and losses
   - Content and page performance insights
   - Strategic outlook for next month
2. A monthly action plan with 6 prioritized, concrete tasks

DATA:
GSC Performance (${d.monthLabel}):
- Clicks: ${d.gsc.monthClicks.toLocaleString()} (prev: ${d.gsc.prevMonthClicks.toLocaleString()}, ${pctStr(d.gsc.clicksPct)})
- Impressions: ${d.gsc.monthImpressions.toLocaleString()}
- CTR: ${d.gsc.monthCtr}% (prev: ${d.gsc.prevCtr}%)
- Avg position: ${d.gsc.avgPosition}
Top gaining pages (YoY by clicks):
${gainers}
Top dropping pages:
${droppers}

${d.ga4 ? `GA4 Performance:
- Organic sessions: ${d.ga4.monthSessions.toLocaleString()} (prev: ${d.ga4.prevSessions.toLocaleString()}, ${pctStr(d.ga4.sessionsPct)})
- Conversions: ${d.ga4.totalConversions.toLocaleString()} (prev: ${d.ga4.prevConversions.toLocaleString()}, ${pctStr(d.ga4.conversionsPct)})
- Revenue: ${fmtUsd(d.ga4.totalRevenue)} (prev: ${fmtUsd(d.ga4.prevRevenue)}, ${pctStr(d.ga4.revenuePct)})
- Bounce rate: ${(d.ga4.bounceRate * 100).toFixed(1)}%` : 'GA4: Not available'}

SEMrush Rankings:
- Total tracked keywords: ${d.semrush.totalKeywords.toLocaleString()}
- Top 3: ${d.semrush.top3} | Top 10: ${d.semrush.top10} | Top 20: ${d.semrush.top20}
- Avg position: ${d.semrush.avgPosition}
- Est. organic traffic: ${d.semrush.organicTraffic.toLocaleString()}
Keywords improved this period:
${kwUp}
Keywords dropped:
${kwDown}

Share of Voice:
${sov}

Action Items this month:
- Created: ${d.actionItems.total} | Completed: ${d.actionItems.done} | Still open: ${d.actionItems.pending + d.actionItems.inProgress}

Paid Backlinks:
- Total active backlinks: ${d.backlinks.totalActive}
- New links acquired this month: ${d.backlinks.newThisMonth}
- Cost this month: ${d.backlinks.totalCostThisMonth > 0 ? `$${d.backlinks.totalCostThisMonth.toLocaleString()}` : 'n/a'}
- Total portfolio cost: ${d.backlinks.totalCostAllTime > 0 ? `$${d.backlinks.totalCostAllTime.toLocaleString()}` : 'n/a'}
${d.backlinks.avgPositionImprovement != null ? `- Avg position improvement for linked pages: ${d.backlinks.avgPositionImprovement} positions` : ''}
- Pending / broken: ${d.backlinks.pendingLinks} / ${d.backlinks.brokenLinks}

Tracked competitors: ${competitors}

${agentInsightsBlock}

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:
[Write the 4-5 paragraph executive narrative here]

---ACTION_PLAN---
1. **[Task title]** — [2-3 sentence explanation of what to do and why it matters this month]
2. **[Task title]** — [explanation]
3. **[Task title]** — [explanation]
4. **[Task title]** — [explanation]
5. **[Task title]** — [explanation]
6. **[Task title]** — [explanation]`
}
