// ─── Monthly Report — AI narrative prompt builder ────────────────────────────
//
// Sprint #358 MONTHLY.SPLIT — extracted from the monthly route so both
// the hot path (legacy single-shot, no longer used) and the new
// /api/reports/monthly/narrative endpoint share the exact same prompt.
//
// Pure function — no DB, no fetch. Takes the report_data payload and
// returns a string ready to drop into Anthropic messages.

import { formatInsightsForPrompt } from './agent-insights'

export interface NarrativePromptInput {
  monthStart:      string
  monthEnd:        string
  monthLabel:      string
  prevMonthLabel:  string
  gsc: {
    monthClicks:        number
    prevMonthClicks:    number
    clicksPct:          number | null
    monthImpressions:   number
    monthCtr:           number
    prevCtr:            number
    avgPosition:        number
    topGainers:         { page: string; delta: number }[]
    topDroppers:        { page: string; delta: number }[]
  }
  ga4: {
    monthSessions:     number
    prevSessions:      number
    sessionsPct:       number | null
    bounceRate:        number
    totalConversions:  number
    prevConversions:   number
    conversionsPct:    number | null
    totalRevenue:      number
    prevRevenue:       number
    revenuePct:        number | null
  } | null
  semrush: {
    totalKeywords:    number
    top3:             number
    top10:            number
    top20:            number
    avgPosition:      number
    organicTraffic:   number
    topMoversUp:      { keyword: string; position: number; positionDiff: number; volume: number }[]
    topMoversDown:    { keyword: string; position: number; positionDiff: number; volume: number }[]
  }
  actionItems: { total: number; pending: number; inProgress: number; done: number }
  competitive: {
    trackedCompetitors: { domain: string; name?: string }[]
    sovTable:           { domain: string; sov: number }[]
  }
  backlinks: {
    totalActive:             number
    newThisMonth:            number
    pendingLinks:            number
    brokenLinks:             number
    totalCostThisMonth:      number
    totalCostAllTime:        number
    avgPositionImprovement:  number | null
  }
  agentInsights?: { windowStart: string; windowEnd: string } | null
  siteName?:      string
}

export function buildNarrativePrompt(d: NarrativePromptInput): string {
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
