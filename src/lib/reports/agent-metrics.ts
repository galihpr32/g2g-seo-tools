// ─── Agent performance metrics aggregator ────────────────────────────────
// Single library that combines data from multiple sources into a single
// executive-friendly metrics blob:
//   - agent_runs / agent_actions  (Heimdall, Loki, Odin, Hermod, Bragi)
//   - bifrost_runs                 (News listener)
//   - seo_content_briefs           (Bragi output)
//   - product_content_queue        (Product Content + CMS upload)
//   - api_usage_logs               (cost tracking)
//
// "Time saved" estimates use these per-task baselines (manual labour avg):
//   - Brief from scratch:        4 hours    @ $25/hr  =  $100
//   - Product content (per ID):  1 hour     @ $20/hr  =  $20
//   - CMS upload (manual):       15 minutes @ $15/hr  =  $3.75
//   - Keyword research session:  2 hours    @ $25/hr  =  $50
//   - News/trend monitoring:     1 hour/day @ $25/hr  =  $25/day
//
// Numbers are conservative estimates — adjust constants below if business
// has firmer comps. The point is to show ORDER OF MAGNITUDE savings, not
// audit-grade accounting.

import type { SupabaseClient } from '@supabase/supabase-js'

const COST_PER_BRIEF        = 100
const COST_PER_CONTENT_ARTICLE = 20
const COST_PER_CMS_UPLOAD   = 3.75
const COST_PER_KEYWORD_RUN  = 50
const COST_PER_NEWS_DAY     = 25

const HOURS_PER_BRIEF       = 4
const HOURS_PER_CONTENT     = 1
const HOURS_PER_CMS_UPLOAD  = 0.25
const HOURS_PER_KEYWORD_RUN = 2

export interface AgentMetrics {
  window_days:      number
  since:            string
  // Per-agent counts
  agents: {
    heimdall:  { runs: number; opportunities: number; success_rate: number }
    odin:      { runs: number; opportunities: number; success_rate: number }
    loki:      { runs: number; opportunities: number; success_rate: number }
    bragi:     { runs: number; briefs_generated: number; auto_approved: number; success_rate: number }
    hermod:    { runs: number; prospects_found: number; success_rate: number }
    tyr:       { reviews: number; auto_approved: number; needs_review: number }
    bifrost:   { runs: number; news_articles: number; game_extractions: number }
  }
  // Output totals
  content: {
    briefs_total:        number
    briefs_published:    number
    product_content:     number
    product_content_uploaded: number
    opportunities_total: number
  }
  // Cost (USD)
  cost: {
    dataforseo:   number
    anthropic:    number
    firecrawl:    number
    other:        number
    total:        number
    api_calls_total: number
  }
  // Estimated savings (USD) vs manual baseline
  savings: {
    briefs:           number
    product_content:  number
    cms_upload:       number
    keyword_research: number
    news_monitoring:  number
    total:            number
    hours_saved:      number
  }
  // For executive pull-quote
  net_value: number   // savings.total - cost.total
}

export async function computeAgentMetrics(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:       SupabaseClient<any, any, any>,
  ownerId:  string,
  siteSlug: string,
  windowDays: number = 7,
): Promise<AgentMetrics> {
  const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  // ── Parallel fetch — keep API call count low ────────────────────────────
  const [
    runsRes,
    actionsRes,
    briefsRes,
    contentRes,
    apiCostsRes,
    bifrostRes,
    oppsRes,
  ] = await Promise.all([
    db.from('agent_runs')
      .select('agent_key, status, findings_count, started_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('started_at', sinceIso),
    db.from('agent_actions')
      .select('agent_key, status, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('created_at', sinceIso),
    db.from('seo_content_briefs')
      .select('id, status, output_type, tyr_score, tyr_status, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('created_at', sinceIso),
    db.from('product_content_queue')
      .select('id, status, cms_upload_status, generated_at, cms_uploaded_at, created_at')
      .eq('owner_user_id', ownerId)
      .gte('created_at', sinceIso),
    db.from('api_usage_logs')
      .select('api_name, endpoint, call_count, cost_usd, created_at')
      .gte('created_at', sinceIso),
    db.from('bifrost_runs')
      .select('items_new, items_extracted, status, started_at')
      .eq('owner_user_id', ownerId)
      .gte('started_at', sinceIso),
    db.from('seo_opportunities')
      .select('id, status, created_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .gte('created_at', sinceIso),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runs: any[] = runsRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = actionsRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const briefs: any[] = briefsRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = contentRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiCosts: any[] = apiCostsRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bifrost: any[] = bifrostRes.data ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const opps: any[] = oppsRes.data ?? []

  function agentSummary(key: string) {
    const r = runs.filter(x => x.agent_key === key)
    const a = actions.filter(x => x.agent_key === key)
    const success = r.filter(x => x.status === 'success').length
    return {
      runs:          r.length,
      opportunities: a.length,
      success_rate:  r.length > 0 ? Math.round((success / r.length) * 100) : 0,
    }
  }

  // Bragi-specific: count auto-approved briefs (Tyr score ≥ threshold)
  const briefsGenerated = briefs.length
  const briefsAutoApproved = briefs.filter(b => b.status === 'auto_approved').length

  // Tyr summary derives from briefs that have a tyr_score
  const tyrReviewed = briefs.filter(b => b.tyr_score != null).length
  const tyrAutoApproved = briefsAutoApproved
  const tyrNeedsReview = briefs.filter(b => b.status === 'needs_review').length

  // Bifrost: aggregate
  const bifrostRuns = bifrost.length
  const newsArticles = bifrost.reduce((s, x) => s + (x.items_new ?? 0), 0)
  const gameExtractions = bifrost.reduce((s, x) => s + (x.items_extracted ?? 0), 0)

  // Product content
  const contentGenerated = content.filter(c => c.status === 'generated').length
  const contentUploaded  = content.filter(c => c.cms_upload_status === 'uploaded').length

  // Cost breakdown by API
  const costByApi = { dataforseo: 0, anthropic: 0, firecrawl: 0, other: 0 }
  let totalCalls = 0
  for (const c of apiCosts) {
    const cost = Number(c.cost_usd ?? 0)
    totalCalls += Number(c.call_count ?? 1)
    const api = String(c.api_name ?? '').toLowerCase()
    if (api === 'dataforseo')      costByApi.dataforseo  += cost
    else if (api === 'anthropic' || api === 'claude') costByApi.anthropic += cost
    else if (api === 'firecrawl')  costByApi.firecrawl   += cost
    else                            costByApi.other       += cost
  }
  const totalCost = costByApi.dataforseo + costByApi.anthropic + costByApi.firecrawl + costByApi.other

  // Savings vs manual labor
  const savingsBriefs        = briefsGenerated     * COST_PER_BRIEF
  const savingsContent       = contentGenerated    * COST_PER_CONTENT_ARTICLE
  const savingsCmsUpload     = contentUploaded     * COST_PER_CMS_UPLOAD
  // Keyword research: every Loki run replaces an analyst session
  const lokiRuns = runs.filter(r => r.agent_key === 'loki' && r.status === 'success').length
  const savingsKeywordRun    = lokiRuns            * COST_PER_KEYWORD_RUN
  // News monitoring: 1 day of manual work saved per day Bifrost ran successfully
  const bifrostSuccessDays = new Set(
    bifrost.filter(b => b.status === 'success').map(b => String(b.started_at).slice(0, 10))
  ).size
  const savingsNews = bifrostSuccessDays * COST_PER_NEWS_DAY

  const savingsTotal = savingsBriefs + savingsContent + savingsCmsUpload + savingsKeywordRun + savingsNews
  const hoursSaved   = briefsGenerated * HOURS_PER_BRIEF
                     + contentGenerated * HOURS_PER_CONTENT
                     + contentUploaded * HOURS_PER_CMS_UPLOAD
                     + lokiRuns * HOURS_PER_KEYWORD_RUN
                     + bifrostSuccessDays * 1   // 1 hr/day

  return {
    window_days: windowDays,
    since:       sinceIso,
    agents: {
      heimdall: agentSummary('heimdall'),
      odin:     agentSummary('odin'),
      loki:     agentSummary('loki'),
      bragi: {
        ...agentSummary('bragi'),
        briefs_generated: briefsGenerated,
        auto_approved:    briefsAutoApproved,
      },
      hermod: {
        runs:            runs.filter(r => r.agent_key === 'hermod').length,
        prospects_found: actions.filter(a => a.agent_key === 'hermod').length,
        success_rate:    agentSummary('hermod').success_rate,
      },
      tyr: {
        reviews:        tyrReviewed,
        auto_approved:  tyrAutoApproved,
        needs_review:   tyrNeedsReview,
      },
      bifrost: {
        runs:             bifrostRuns,
        news_articles:    newsArticles,
        game_extractions: gameExtractions,
      },
    },
    content: {
      briefs_total:             briefsGenerated,
      briefs_published:         briefs.filter(b => b.status === 'published').length,
      product_content:          contentGenerated,
      product_content_uploaded: contentUploaded,
      opportunities_total:      opps.length,
    },
    cost: {
      ...costByApi,
      total:           Number(totalCost.toFixed(2)),
      api_calls_total: totalCalls,
    },
    savings: {
      briefs:           savingsBriefs,
      product_content:  savingsContent,
      cms_upload:       savingsCmsUpload,
      keyword_research: savingsKeywordRun,
      news_monitoring:  savingsNews,
      total:            savingsTotal,
      hours_saved:      Math.round(hoursSaved),
    },
    net_value: Number((savingsTotal - totalCost).toFixed(2)),
  }
}
