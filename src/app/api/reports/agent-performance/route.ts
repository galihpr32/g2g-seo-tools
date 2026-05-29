import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { computeAgentMetrics } from '@/lib/reports/agent-metrics'

export const maxDuration = 30

/**
 * GET /api/reports/agent-performance?days=7|30|90
 *
 * Executive-friendly agent performance + savings rollup. Combines:
 *   - agent_runs / agent_actions (the 5 detection agents)
 *   - bifrost_runs (news listener)
 *   - seo_content_briefs (Bragi output, Tyr review)
 *   - product_content_queue (Bragi product flow, CMS upload)
 *   - api_usage_logs (cost tracking)
 *
 * Also returns a previous-period comparison so the dashboard can show
 * week-over-week deltas.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days = Math.min(90, Math.max(1, parseInt(searchParams.get('days') ?? '7', 10)))

  // Current window + double-window (for previous-window subtraction). Then
  // compute the "previous period only" totals by subtracting current from double.
  const current = await computeAgentMetrics(db, ownerId, siteSlug, days)
  const doubled = await computeAgentMetrics(db, ownerId, siteSlug, days * 2)

  // Previous window = double - current (rolled-up totals only — agent breakdown
  // is difficult to subtract cleanly, so we omit that detail from prev).
  const prevSinceIso = new Date(Date.now() - days * 2 * 86_400_000).toISOString()
  const previous = {
    ...doubled,
    window_days: days,
    since:       prevSinceIso,
    content: {
      briefs_total:             doubled.content.briefs_total             - current.content.briefs_total,
      briefs_published:         doubled.content.briefs_published         - current.content.briefs_published,
      product_content:          doubled.content.product_content          - current.content.product_content,
      product_content_uploaded: doubled.content.product_content_uploaded - current.content.product_content_uploaded,
      opportunities_total:      doubled.content.opportunities_total      - current.content.opportunities_total,
    },
    cost: {
      dataforseo:      Number((doubled.cost.dataforseo      - current.cost.dataforseo).toFixed(2)),
      anthropic:       Number((doubled.cost.anthropic       - current.cost.anthropic).toFixed(2)),
      firecrawl:       Number((doubled.cost.firecrawl       - current.cost.firecrawl).toFixed(2)),
      other:           Number((doubled.cost.other           - current.cost.other).toFixed(2)),
      total:           Number((doubled.cost.total           - current.cost.total).toFixed(2)),
      api_calls_total: doubled.cost.api_calls_total - current.cost.api_calls_total,
    },
    savings: {
      briefs:           doubled.savings.briefs           - current.savings.briefs,
      product_content:  doubled.savings.product_content  - current.savings.product_content,
      cms_upload:       doubled.savings.cms_upload       - current.savings.cms_upload,
      keyword_research: doubled.savings.keyword_research - current.savings.keyword_research,
      news_monitoring:  doubled.savings.news_monitoring  - current.savings.news_monitoring,
      total:            doubled.savings.total            - current.savings.total,
      hours_saved:      doubled.savings.hours_saved      - current.savings.hours_saved,
    },
    net_value: Number((doubled.net_value - current.net_value).toFixed(2)),
  }

  // Compute percentage deltas for top-line content + savings
  const pct = (curr: number, prev: number): number | null => {
    if (prev === 0) return curr > 0 ? null : 0   // null = "new from 0"
    return Math.round(((curr - prev) / prev) * 100)
  }
  const deltas = {
    briefs_pct:        pct(current.content.briefs_total,             previous.content.briefs_total),
    content_pct:       pct(current.content.product_content,          previous.content.product_content),
    cms_upload_pct:    pct(current.content.product_content_uploaded, previous.content.product_content_uploaded),
    savings_pct:       pct(current.savings.total,                    previous.savings.total),
    cost_pct:          pct(current.cost.total,                       previous.cost.total),
    opportunities_pct: pct(current.content.opportunities_total,      previous.content.opportunities_total),
  }

  return NextResponse.json({
    current,
    previous,
    deltas,
  })
}
