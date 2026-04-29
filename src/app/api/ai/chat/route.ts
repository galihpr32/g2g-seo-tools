import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import Anthropic from '@anthropic-ai/sdk'

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

interface Message { role: 'user' | 'assistant'; content: string }

// ── Page context map ──────────────────────────────────────────────────────────

const PAGE_CONTEXTS: Record<string, string> = {
  '/dashboard':                        'the main SEO dashboard showing traffic, clicks, and impressions overview',
  '/gsc/ranking-drop':                 'GSC Clicks Drop Alert — monitors pages that lost traffic recently',
  '/gsc/product-rankings':             'Top Product Tracker — tracks keyword rankings for specific G2G product pages',
  '/gsc/action-items':                 'Action Items — SEO tasks and content briefs assigned to the team',
  '/gsc/index-coverage':               'Index Coverage — shows Google indexing status for G2G pages',
  '/gsc/core-web-vitals':              'Core Web Vitals — page performance metrics (LCP, CLS, INP)',
  '/ga4/organic-traffic':              'GA4 Organic Traffic — sessions, engagement, and organic conversions',
  '/ga4/content-performance':          'Content Performance — which pages drive the most engaged traffic',
  '/semrush/rankings':                 'SEMrush Keyword Rankings — G2G organic keyword positions with intent badges',
  '/semrush/site-audit':               'Site Audit — technical SEO issues and DataForSEO on-page health check',
  '/competitive/keyword-gap':          'Keyword Gap Finder — keywords competitors rank for that G2G does not',
  '/competitive/opportunities':        'Competitive Opportunities — potential new pages based on keyword gaps',
  '/competitive/serp-tracker':         'SERP & Share of Voice — G2G visibility across tracked keywords',
  '/content/trends':                   'Game Trends — trending games by Steam players and search volume',
  '/content/studio':                   'Content Studio — AI-powered content creation wizard for G2G product pages',
  '/content/briefs':                   'Brief Library — all AI-generated and reviewed SEO content briefs',
  '/content/briefs/':                  'Brief detail page — full brief content, Tyr quality score, and action buttons (Regenerate, Run Tyr, Mark Published)',
  '/content/writer-inbox':             'Writer Inbox — approved briefs ready for writers to pick up and draft',
  '/content/calendar':                 'Editorial Calendar — timeline view of in-flight and published content across all briefs',
  '/content/internal-links':           'Internal Linking Manager — surface internal link opportunities across G2G pages',
  '/content/cannibalization':          'Keyword Cannibalization Detector — pages competing for the same keywords',
  '/content/broken-urls':              'Broken URL Monitor — 4xx/5xx pages, ghost pages lost from GSC, pages with broken outlinks',
  '/content/keyword-map':              'Keyword Map — visual cluster map of the G2G keyword universe',
  '/command-center':                   'Command Center — run Norse AI agents, monitor pipeline health, review findings',
  '/command-center/opportunities':     'Opportunities — unified triage queue grouping Heimdall + Loki + Odin signals by topic. Queue Brief here to send an opportunity to Bragi.',
  '/knowledge-base':                   'Knowledge Base — G2G brand guidelines, USPs, and writing rules for Bragi and writers',
  '/reports/weekly':                   'Weekly Pulse Report — weekly SEO performance summary for G2G',
  '/reports/monthly':                  'Monthly SEO Report — monthly performance, wins, and action plan',
  '/reports/backlinks':                'Backlink Audit — referring domains, anchor text, and toxic link signals',
  '/reports/ranking-impact':           'Ranking Impact Tracker — GSC before/after snapshots for every published brief',
  '/reports/content-roi':              'Content ROI — estimated revenue impact of published SEO content',
  '/backlinks':                        'Backlink Tracker — paid and organic backlinks being monitored',
  '/outreach':                         'Guestpost Outreach — managing outreach prospects and campaign progress',
  '/campaigns':                        'SEO Campaigns — active campaign tracking with kanban board',
  '/team-performance':                 'Team Performance — output and activity metrics for the SEO team',
}

function getPageContext(pathname: string): string {
  if (PAGE_CONTEXTS[pathname]) return PAGE_CONTEXTS[pathname]
  for (const [key, desc] of Object.entries(PAGE_CONTEXTS)) {
    if (pathname.startsWith(key)) return desc
  }
  return 'the G2G SEO Tools dashboard'
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'query_keyword_gaps',
    description: 'Find keywords that competitors rank for but G2G does not. Returns the most recent Loki agent findings from the keyword gap analysis. Use this when asked about keyword opportunities, gaps, competitor advantages, or "what keywords am I missing".',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit:      { type: 'number', description: 'Max gaps to return (default 10)' },
        min_volume: { type: 'number', description: 'Minimum monthly search volume filter (default 0)' },
        priority:   { type: 'string', enum: ['high', 'medium', 'low', 'all'], description: 'Filter by priority level' },
      },
    },
  },
  {
    name: 'get_ranking_data',
    description: 'Get G2G keyword rankings and top-performing pages from GSC snapshots. Use for questions about current ranking positions, pages gaining or losing traffic, CTR trends, or overall organic performance.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days:  { type: 'number', description: 'Lookback period in days (default 30)' },
        limit: { type: 'number', description: 'Number of top pages to return (default 15)' },
      },
    },
  },
  {
    name: 'get_action_items',
    description: 'Get current SEO action items and their status. Use for questions about what the team is working on, what is pending, completed tasks, or workload status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'all'], description: 'Filter by status (default: all)' },
        limit:  { type: 'number', description: 'Number of items to return (default 15)' },
      },
    },
  },
  {
    name: 'get_competitor_sov',
    description: 'Get Share of Voice (SoV) comparison between G2G and tracked competitors from SERP snapshot data. Use for questions about competitive position, who is winning which keywords, or how G2G visibility compares to rivals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        days: { type: 'number', description: 'Lookback period in days (default 30)' },
      },
    },
  },
  {
    name: 'get_backlinks',
    description: 'Get paid backlink data — active links, recent acquisitions, broken links, costs, and position improvements. Use for questions about link building progress, ROI, or link portfolio health.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['active', 'pending', 'broken', 'all'], description: 'Filter by link status (default: all)' },
        limit:  { type: 'number', description: 'Number of links (default 15)' },
      },
    },
  },
  {
    name: 'get_agent_insights',
    description: 'Get recent run summaries and findings from the Norse AI agents: Heimdall (monitoring), Odin (trends), Loki (competitive analysis), Bragi (content writing), Hermod (outreach), Saga (content briefs), Tyr (action review), Vor (audit). Use when asked what agents found, their last activity, or pending agent actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string', enum: ['heimdall', 'odin', 'loki', 'bragi', 'hermod', 'saga', 'tyr', 'vor', 'all'], description: 'Which agent to query (default: all)' },
        limit: { type: 'number', description: 'Number of recent runs (default 5)' },
      },
    },
  },
  {
    name: 'get_content_opportunities',
    description: 'Get page creation opportunities — keywords and topics where G2G could create new content to rank. Use for questions about content gaps, new page ideas, or what content to create next.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit:      { type: 'number', description: 'Number of opportunities (default 10)' },
        min_volume: { type: 'number', description: 'Minimum search volume (default 100)' },
      },
    },
  },
  {
    name: 'get_opportunities',
    description: 'Get SEO opportunities from the pipeline triage queue — topics grouped from Heimdall (click drops), Loki (keyword gaps), and Odin (trending games). Use when the user asks what opportunities exist, what topics to prioritise, what signals Saga aggregated, or which opportunities have briefs ready.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['new', 'in_review', 'brief_queued', 'brief_ready', 'dismissed', 'all'], description: 'Filter by status (default: all active)' },
        limit:  { type: 'number', description: 'Number of opportunities to return (default 10)' },
      },
    },
  },
  {
    name: 'propose_agent_run',
    description: 'Propose triggering one of the 8 Norse SEO agents on the user\'s behalf. ALWAYS call this tool when the user asks to run, trigger, kick off, or start an agent — never skip it. Returns a confirmation_token and last-run metadata. You must embed the returned ui_directive in your reply between <<<MIMIR_CONFIRM>>> markers so the frontend can render Yes/No buttons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: {
          type: 'string',
          enum: ['heimdall', 'loki', 'odin', 'bragi', 'hermod', 'saga', 'tyr', 'vor'],
          description: 'The agent to propose running',
        },
      },
      required: ['agent'],
    },
  },
]

// ── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  ownerId: string
): Promise<string> {
  const db = createServiceClient()

  try {
    switch (toolName) {

      case 'query_keyword_gaps': {
        const limit     = Number(toolInput.limit      ?? 10)
        const minVolume = Number(toolInput.min_volume ?? 0)
        const priority  = String(toolInput.priority   ?? 'all')

        const query = db
          .from('agent_actions')
          .select('title, description, data, created_at, priority, status')
          .eq('owner_user_id', ownerId)
          .eq('agent_key', 'loki')
          .eq('action_type', 'add_action_item')
          .in('status', ['pending', 'approved', 'executed'])
          .order('created_at', { ascending: false })
          .limit(50)

        const { data } = await query
        let gaps = (data ?? []).filter(a => {
          const d = a.data as Record<string, unknown>
          const vol = Number(d.search_volume ?? 0)
          if (vol < minVolume) return false
          if (priority !== 'all' && a.priority !== priority) return false
          return true
        })
        .slice(0, limit)
        .map(a => {
          const d = a.data as Record<string, unknown>
          return {
            keyword:              String(d.keyword ?? ''),
            competitor:           String(d.competitor_domain ?? ''),
            competitor_position:  d.competitor_position,
            our_position:         d.our_position ?? 'not ranking',
            search_volume:        Number(d.search_volume ?? 0),
            priority:             a.priority,
          }
        })

        if (!gaps.length) return 'No keyword gaps found in DB. The Loki agent needs to run first to identify gaps. Recommend triggering Loki from the Agents page.'

        return `Found ${gaps.length} keyword gap${gaps.length > 1 ? 's' : ''} (from Loki agent):\n\n` +
          gaps.map((g, i) =>
            `${i + 1}. **"${g.keyword}"** [${g.priority} priority]\n   • ${g.competitor} ranks #${g.competitor_position}, G2G: ${g.our_position}\n   • ${g.search_volume.toLocaleString()} searches/month`
          ).join('\n\n')
      }

      case 'get_ranking_data': {
        const days  = Number(toolInput.days  ?? 30)
        const limit = Number(toolInput.limit ?? 15)
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

        const { data: snaps } = await db
          .from('gsc_ranking_snapshots')
          .select('page, clicks, impressions, position, snapshot_date')
          .gte('snapshot_date', since)
          .order('clicks', { ascending: false })
          .limit(200)

        if (!snaps?.length) return `No GSC ranking data found for the last ${days} days. Connect Google Search Console to start tracking.`

        // Aggregate by page
        const pageMap = new Map<string, { clicks: number; impressions: number; positions: number[] }>()
        for (const s of snaps) {
          const p = pageMap.get(s.page) ?? { clicks: 0, impressions: 0, positions: [] }
          p.clicks      += s.clicks ?? 0
          p.impressions += s.impressions ?? 0
          if (s.position) p.positions.push(s.position)
          pageMap.set(s.page, p)
        }

        const pages = Array.from(pageMap.entries())
          .map(([page, v]) => ({
            page:     page.replace('https://www.g2g.com', '').replace('https://g2g.com', '') || '/',
            clicks:   v.clicks,
            impressions: v.impressions,
            avgPos:   v.positions.length ? +(v.positions.reduce((a, b) => a + b, 0) / v.positions.length).toFixed(1) : 0,
          }))
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, limit)

        const totalClicks       = pages.reduce((s, p) => s + p.clicks, 0)
        const totalImpressions  = pages.reduce((s, p) => s + p.impressions, 0)

        return `GSC data for last ${days} days:\n` +
          `Total clicks: ${totalClicks.toLocaleString()} | Impressions: ${totalImpressions.toLocaleString()}\n\n` +
          `Top ${pages.length} pages by clicks:\n` +
          pages.map((p, i) =>
            `${i + 1}. ${p.page}\n   ${p.clicks.toLocaleString()} clicks · ${p.impressions.toLocaleString()} impr · avg pos ${p.avgPos}`
          ).join('\n')
      }

      case 'get_action_items': {
        const statusFilter = String(toolInput.status ?? 'all')
        const limit        = Number(toolInput.limit  ?? 15)

        // agent_actions = the approval queue where agents write pending items.
        // seo_action_items = the team's work tracker (populated when executor
        //   approves an action). We query both so Mimir sees the full picture.

        // 1. Pending items in the approval queue (agent_actions)
        const { data: agentActions } = await db
          .from('agent_actions')
          .select('title, action_type, priority, status, agent_key, created_at')
          .eq('owner_user_id', ownerId)
          .in('status', ['pending'])
          .order('created_at', { ascending: false })
          .limit(limit)

        // 2. Approved / in-progress / done items in the team work tracker
        const teamQuery = db
          .from('seo_action_items')
          .select('title, action_type, status, priority, assigned_to, created_at, completed_at')
          .eq('owner_user_id', ownerId)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (statusFilter === 'pending') {
          // Only the approval queue — skip team tracker query
        } else if (statusFilter !== 'all') {
          teamQuery.eq('status', statusFilter)
        }

        const { data: teamItems } = statusFilter === 'pending'
          ? { data: [] as Array<{ title: string; action_type: string; status: string; priority: string; assigned_to?: string | null; created_at: string; completed_at?: string | null }> }
          : await teamQuery

        const pendingCount = agentActions?.length ?? 0
        const teamCount    = teamItems?.length ?? 0

        if (!pendingCount && !teamCount) {
          return `No action items found${statusFilter !== 'all' ? ` with status "${statusFilter}"` : ''}. ` +
            `Run Detection agents (Heimdall, Odin, Loki) to surface new opportunities.`
        }

        let result = ''

        if (pendingCount > 0) {
          result += `\n🟡 **Pending in Approval Queue** (${pendingCount} — needs review):\n`
          result += (agentActions ?? []).slice(0, 8).map(i =>
            `• [${i.agent_key}] [${i.priority}] ${i.title}`
          ).join('\n')
        }

        if (teamCount > 0) {
          const inProgress = (teamItems ?? []).filter(i => i.status === 'in_progress')
          const done       = (teamItems ?? []).filter(i => i.status === 'done')
          const pending    = (teamItems ?? []).filter(i => i.status === 'pending')

          if (pending.length)    result += `\n\n📋 **Team Queue — Pending** (${pending.length}):\n` + pending.slice(0, 5).map(i => `• [${i.priority}] ${i.title}`).join('\n')
          if (inProgress.length) result += `\n\n🔵 **Team Queue — In Progress** (${inProgress.length}):\n` + inProgress.slice(0, 5).map(i => `• [${i.priority}] ${i.title}`).join('\n')
          if (done.length)       result += `\n\n✅ **Done recently** (${done.length}):\n` + done.slice(0, 3).map(i => `• ${i.title}`).join('\n')
        }

        return `Action items summary (${pendingCount} pending approval · ${teamCount} in team tracker):\n${result}`
      }

      case 'get_competitor_sov': {
        const days  = Number(toolInput.days ?? 30)
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

        const { data: snaps } = await db
          .from('serp_snapshots')
          .select('keyword, results, snapshot_date')
          .eq('owner_user_id', ownerId)
          .gte('snapshot_date', since)
          .order('snapshot_date', { ascending: false })

        if (!snaps?.length) return `No SERP snapshot data for the last ${days} days. Run the SERP Tracker to start collecting Share of Voice data.`

        type FlatRow = { domain: string; position: number }
        const sov = new Map<string, number>()
        const kwCnt = new Map<string, number>()
        for (const snap of snaps) {
          const results = (snap.results ?? []) as FlatRow[]
          for (const r of results) {
            if (!r.domain || r.position > 10) continue
            const d = r.domain.replace(/^www\./, '')
            sov.set(d, (sov.get(d) ?? 0) + 1)
            kwCnt.set(d, (kwCnt.get(d) ?? 0) + 1)
          }
        }

        const totalAppearances = Array.from(sov.values()).reduce((a, b) => a + b, 0)
        const rows = Array.from(sov.entries())
          .map(([domain, count]) => ({ domain, sov: +((count / totalAppearances) * 100).toFixed(1), keywords: kwCnt.get(domain) ?? 0 }))
          .sort((a, b) => b.sov - a.sov)
          .slice(0, 8)

        const g2gRow = rows.find(r => r.domain === 'g2g.com')
        return `Share of Voice — last ${days} days (${snaps.length} keyword snapshots):\n\n` +
          rows.map((r, i) => {
            const isG2G = r.domain === 'g2g.com'
            return `${i + 1}. ${isG2G ? '**G2G**' : r.domain}: **${r.sov}%** SoV (${r.keywords} top-10 appearances)`
          }).join('\n') +
          (g2gRow ? `\n\nG2G is at position ${rows.findIndex(r => r.domain === 'g2g.com') + 1} out of ${rows.length} tracked domains.` : '\n\nG2G has no top-10 appearances in the tracked keywords — critical gap to address.')
      }

      case 'get_backlinks': {
        const status = String(toolInput.status ?? 'all')
        const limit  = Number(toolInput.limit  ?? 15)

        const query = db
          .from('paid_backlinks')
          .select('site_name, external_url, anchor_text, target_page, link_status, live_date, cost_amount, cost_currency, position_current, position_at_creation, target_keyword')
          .eq('owner_user_id', ownerId)
          .order('live_date', { ascending: false })
          .limit(limit)

        const filteredQuery = status !== 'all' ? query.eq('link_status', status) : query

        const { data } = await filteredQuery
        if (!data?.length) return `No backlinks found${status !== 'all' ? ` with status "${status}"` : ''}.`

        const active  = data.filter(b => b.link_status === 'active').length
        const broken  = data.filter(b => b.link_status === 'broken').length
        const pending = data.filter(b => b.link_status === 'pending').length

        const fmtCost = (amt: number | null, cur: string | null) => {
          if (!amt) return 'free'
          const c = (cur ?? 'USD').toUpperCase()
          if (c === 'IDR') return `Rp ${amt.toLocaleString()}`
          return `$${amt.toLocaleString()}`
        }

        return `Backlink portfolio summary: ${active} active · ${pending} pending · ${broken} broken\n\n` +
          `Recent backlinks:\n` +
          data.slice(0, 10).map(b => {
            const posDiff = (b.position_at_creation != null && b.position_current != null)
              ? b.position_at_creation - b.position_current : null
            const posStr = b.position_current ? `pos #${b.position_current}${posDiff && posDiff > 0 ? ` (↑${posDiff})` : ''}` : 'no pos data'
            return `• **${b.site_name}** [${b.link_status}] — "${b.anchor_text}" → ${b.target_page.replace('https://www.g2g.com', '') || '/'}\n  ${posStr} · cost: ${fmtCost(b.cost_amount, b.cost_currency)}`
          }).join('\n')
      }

      case 'get_agent_insights': {
        const agent = String(toolInput.agent ?? 'all')
        const limit = Number(toolInput.limit ?? 5)

        // agent_runs uses started_at (not created_at) as the primary timestamp
        const runsQuery = db
          .from('agent_runs')
          .select('agent_key, status, summary, findings_count, actions_queued, started_at, finished_at')
          .eq('owner_user_id', ownerId)
          .order('started_at', { ascending: false })
          .limit(agent === 'all' ? limit * 5 : limit)

        if (agent !== 'all') runsQuery.eq('agent_key', agent)

        const { data: runs } = await runsQuery

        // Pending actions in the approval queue
        const { data: pendingActions } = await db
          .from('agent_actions')
          .select('agent_key, action_type, title, priority, status')
          .eq('owner_user_id', ownerId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(10)

        const AGENT_NAMES: Record<string, string> = {
          heimdall: 'Heimdall (Click Drops)', odin: 'Odin (Trending Games)',
          loki: 'Loki (Keyword Gaps)', bragi: 'Bragi (Brief Generator)', hermod: 'Hermod (Outreach)',
          saga: 'Saga (Aggregator)', tyr: 'Tyr (Brief Quality)', vor: 'Vor (Daily Reporter)',
        }

        // If no run history AND no pending actions → explain why
        if (!runs?.length && !pendingActions?.length) {
          return agent !== 'all'
            ? `No run history found for ${AGENT_NAMES[agent] ?? agent}. Trigger it from the Command Center or via Mimir.`
            : `No agent run history found. Trigger Detection agents (Heimdall, Odin, Loki) to start the pipeline. ` +
              `Say "run Heimdall" or "trigger Loki" to kick one off.`
        }

        let result = ''

        if (runs?.length) {
          result += `Recent agent activity:\n\n`
          for (const run of runs.slice(0, limit)) {
            const name = AGENT_NAMES[run.agent_key] ?? run.agent_key
            const when = run.started_at
              ? new Date(run.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              : 'unknown'
            const statusEmoji = run.status === 'success' ? '✅' : run.status === 'running' ? '⏳' : run.status === 'partial' ? '⚠️' : '❌'
            result += `**${name}** — ${when} ${statusEmoji} [${run.status}]\n${run.summary ?? 'No summary'}\n`
            if (run.findings_count || run.actions_queued) {
              result += `Findings: ${run.findings_count ?? 0} · Actions queued: ${run.actions_queued ?? 0}\n`
            }
            result += '\n'
          }
        }

        if (pendingActions?.length) {
          result += `\n📋 Pending in approval queue (${pendingActions.length} item${pendingActions.length !== 1 ? 's' : ''}):\n`
          result += pendingActions.slice(0, 8).map(a =>
            `• [${AGENT_NAMES[a.agent_key] ?? a.agent_key}] [${a.priority}] ${a.title}`
          ).join('\n')
          result += '\n\nReview and approve in the **Command Center → Approval Queue**.'
        }

        return result.trim() || 'No agent activity to report.'
      }

      case 'get_content_opportunities': {
        const limit     = Number(toolInput.limit      ?? 10)
        const minVolume = Number(toolInput.min_volume ?? 100)

        const { data } = await db
          .from('agent_actions')
          .select('title, description, data, priority, created_at')
          .eq('owner_user_id', ownerId)
          .eq('agent_key', 'odin')
          .in('status', ['pending', 'approved'])
          .order('created_at', { ascending: false })
          .limit(50)

        const opps = (data ?? [])
          .filter(a => {
            const d = a.data as Record<string, unknown>
            return Number(d.search_volume ?? 0) >= minVolume
          })
          .slice(0, limit)
          .map(a => {
            const d = a.data as Record<string, unknown>
            return {
              title:        a.title,
              keyword:      String(d.keyword ?? ''),
              search_volume: Number(d.search_volume ?? 0),
              priority:     a.priority,
            }
          })

        if (!opps.length) {
          // Fallback: check keyword gaps that suggest content creation
          const { data: gaps } = await db
            .from('agent_actions')
            .select('title, data, priority')
            .eq('owner_user_id', ownerId)
            .eq('agent_key', 'loki')
            .in('status', ['pending', 'approved'])
            .order('created_at', { ascending: false })
            .limit(limit)

          if (!gaps?.length) return 'No content opportunities found. Run Odin (Trends) or Loki (Competitive) agents to discover opportunities.'

          return `${gaps.length} content opportunities from keyword gap analysis:\n\n` +
            gaps.map((g, i) => {
              const d = g.data as Record<string, unknown>
              return `${i + 1}. **"${d.keyword}"** [${g.priority}]\n   ${Number(d.search_volume ?? 0).toLocaleString()}/mo · competitor: ${d.competitor_domain} #${d.competitor_position}`
            }).join('\n\n')
        }

        return `${opps.length} content opportunities (from Odin agent):\n\n` +
          opps.map((o, i) =>
            `${i + 1}. **"${o.keyword}"** [${o.priority}]\n   ${o.search_volume.toLocaleString()} searches/month`
          ).join('\n\n')
      }

      case 'get_opportunities': {
        const status = String(toolInput.status ?? 'all')
        const limit  = Number(toolInput.limit  ?? 10)

        const query = db
          .from('seo_opportunities')
          .select('id, topic, topic_slug, status, output_type, total_sv, signal_count, brief_id, last_signal_at, loki_signals, odin_signals, heimdall_signals')
          .eq('owner_user_id', ownerId)
          .order('total_sv', { ascending: false })
          .limit(limit)

        const oppsQuery = status !== 'all'
          ? query.eq('status', status)
          : query.not('status', 'eq', 'dismissed')

        const { data: opps } = await oppsQuery

        if (!opps?.length) {
          return status === 'all'
            ? 'No opportunities found. Run Detection agents (Heimdall, Loki, Odin) to surface signals — Saga will automatically aggregate them into opportunities.'
            : `No opportunities with status "${status}" found.`
        }

        const statusEmoji: Record<string, string> = {
          new:          '🆕',
          in_review:    '👁',
          brief_queued: '⏳',
          brief_ready:  '✅',
          dismissed:    '❌',
        }

        const lines = (opps as Array<{
          id: string; topic: string; status: string; output_type: string | null;
          total_sv: number; signal_count: number; brief_id: string | null; last_signal_at: string | null;
          loki_signals: unknown[]; odin_signals: unknown[]; heimdall_signals: unknown[];
        }>).map((o, i) => {
          const sources: string[] = []
          if (Array.isArray(o.heimdall_signals) && o.heimdall_signals.length) sources.push('Heimdall')
          if (Array.isArray(o.loki_signals)     && o.loki_signals.length)     sources.push('Loki')
          if (Array.isArray(o.odin_signals)      && o.odin_signals.length)     sources.push('Odin')
          const emoji = statusEmoji[o.status] ?? '•'
          const sv    = o.total_sv ? `${Number(o.total_sv).toLocaleString()} SV` : 'no SV'
          const type  = o.output_type ? ` [${o.output_type.replace('_', ' ')}]` : ''
          const brief = o.brief_id ? ' · has brief' : ''
          return `${i + 1}. ${emoji} **"${o.topic}"**${type} — ${sv} · ${o.signal_count} signal${o.signal_count !== 1 ? 's' : ''} (${sources.join(', ')})${brief}`
        })

        const statusCounts: Record<string, number> = {}
        for (const o of opps as Array<{ status: string }>) {
          statusCounts[o.status] = (statusCounts[o.status] ?? 0) + 1
        }
        const countStr = Object.entries(statusCounts).map(([s, c]) => `${c} ${s}`).join(' · ')

        return `Found ${opps.length} opportunities (${countStr}):\n\n${lines.join('\n')}\n\nGo to **Opportunities** page to triage and queue briefs.`
      }

      case 'propose_agent_run': {
        const VALID_AGENTS = ['heimdall', 'loki', 'odin', 'bragi', 'hermod', 'saga', 'tyr', 'vor']
        const agent = String(toolInput.agent ?? '').toLowerCase()

        if (!VALID_AGENTS.includes(agent)) {
          return JSON.stringify({
            error:       true,
            message:     `Unknown agent "${agent}". Valid agents: ${VALID_AGENTS.join(', ')}.`,
            valid_agents: VALID_AGENTS,
          })
        }

        // Agent category → cooldown hours (from §10.2)
        const CATEGORY_MAP: Record<string, { category: string; cooldown_hours: number }> = {
          heimdall: { category: 'detection',      cooldown_hours: 3   },
          loki:     { category: 'detection',      cooldown_hours: 3   },
          odin:     { category: 'detection',      cooldown_hours: 3   },
          bragi:    { category: 'execution',      cooldown_hours: 1   },
          hermod:   { category: 'execution',      cooldown_hours: 1   },
          saga:     { category: 'execution',      cooldown_hours: 1   },
          tyr:      { category: 'review_control', cooldown_hours: 0.5 },
          vor:      { category: 'review_control', cooldown_hours: 0.5 },
        }
        const { category, cooldown_hours } = CATEGORY_MAP[agent]

        // Fetch most recent run
        const { data: lastRun } = await db
          .from('agent_runs')
          .select('id, started_at, finished_at, status, summary')
          .eq('owner_user_id', ownerId)
          .eq('agent_key', agent)
          .order('started_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const isRunning = !!(lastRun?.status === 'running' && !lastRun.finished_at)

        let hoursSinceLast: number | null = null
        let withinCooldown = false
        if (lastRun?.started_at) {
          hoursSinceLast = (Date.now() - new Date(lastRun.started_at).getTime()) / 3_600_000
          withinCooldown = hoursSinceLast < cooldown_hours
        }

        const costWarning = withinCooldown

        // If already running — return early, no token
        if (isRunning) {
          return JSON.stringify({
            agent,
            category,
            is_running:    true,
            last_run:      lastRun,
            cost_warning:  false,
            cooldown_hours,
            hours_since_last: hoursSinceLast,
          })
        }

        // Store one-time confirmation token (5-min TTL)
        const token = `mimir-trig-${crypto.randomUUID()}`
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
        await db.from('mimir_pending_triggers').insert({
          token,
          owner_user_id: ownerId,
          agent_key:     agent,
          expires_at:    expiresAt,
        })

        return JSON.stringify({
          agent,
          category,
          is_running:    false,
          last_run:      lastRun ?? null,
          cost_warning:  costWarning,
          cooldown_hours,
          hours_since_last: hoursSinceLast !== null ? Math.round(hoursSinceLast * 10) / 10 : null,
          confirmation_token: token,
          ui_directive: {
            type:               'confirm_agent_run',
            agent,
            category,
            cost_warning:       costWarning,
            cooldown_hours,
            hours_since_last:   hoursSinceLast !== null ? Math.round(hoursSinceLast * 10) / 10 : null,
            last_status:        lastRun?.status ?? null,
            last_ran:           lastRun?.started_at ?? null,
            confirmation_token: token,
          },
        })
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (err) {
    console.error(`[mimir] Tool ${toolName} error:`, err)
    return `Error running ${toolName}: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── System prompt — Mimir The All Knowing ────────────────────────────────────

function buildSystemPrompt(pageDesc: string, pageData?: string): string {
  return `You are **Mimir The All Knowing** — the wisest oracle in G2G's SEO intelligence suite.

In Norse mythology, Mimir guards the Well of Wisdom beneath Yggdrasil. Odin sacrificed his eye to drink from it. You are that well: when someone asks you a question, you consult the data and return the truth.

G2G (g2g.com) is a leading peer-to-peer gaming marketplace — in-game currency, items, gift cards, top-ups (Robux, V-Bucks, Free Fire diamonds, etc.), game accounts, boosting services, and GamePal companions. Primary market: US and SEA.

The user is currently on: **${pageDesc}**${pageData ? `\n\nData already visible on this page:\n${pageData}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE PIPELINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

G2G SEO Tools runs a five-stage automated pipeline:

1. **Detection** — Heimdall (click drops), Loki (keyword gaps), Odin (trending games)
2. **Aggregation** — Saga clusters signals by topic into the Opportunities queue
3. **Execution** — Bragi generates SEO content briefs from approved Opportunities
4. **Quality** — Tyr scores each brief (0–100); ≥80 auto-promotes, lower flags for review
5. **Publishing** — Writers work from Brief Library → Writer Inbox → Mark Published → Ranking Impact tracks before/after GSC data

Human decision points: (A) Opportunities triage — approve or dismiss each topic; (B) Brief review — run Tyr, regenerate with notes, or override manually.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR CAPABILITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You have tools to query G2G's live SEO data:
• query_keyword_gaps — what keywords are competitors winning that G2G isn't?
• get_ranking_data — what are G2G's top pages and click trends?
• get_action_items — what is the team working on / what's pending?
• get_competitor_sov — how does G2G's visibility compare to rivals?
• get_backlinks — what does the backlink portfolio look like?
• get_agent_insights — what have the Norse agents (Heimdall, Odin, Loki, Bragi, Hermod, Tyr, Vor) found?
• get_content_opportunities — what new pages or content should G2G create?
• get_opportunities — what topics are in the Opportunities triage queue? What signals did Saga aggregate?

Use tools PROACTIVELY. If the user asks a question that could be answered better with data, call the tool first, then answer. You can call multiple tools if needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEO FRAMEWORKS (from claude-seo)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness)**
When evaluating or recommending content for G2G:
- Experience: does the page show real transaction data, seller reviews, live prices?
- Expertise: does the page demonstrate depth about the game/item category?
- Authoritativeness: does G2G cite its ISO/IEC 27001:2013 cert, GamerProtect, escrow, 200+ payment methods?
- Trustworthiness: verified sellers, buyer protection, dispute resolution — these are G2G's trust signals

**GEO/AEO (Generative Engine Optimization / Answer Engine Optimization)**
G2G content should be optimized for AI search (Google AI Overviews, ChatGPT, Perplexity):
- Use structured FAQ sections answering "how to buy X" / "what is the safest way to buy X"
- Include clear definitions, step-by-step processes, and comparison tables
- Mark up key facts with structured data (FAQ, HowTo, Product schema)
- Target informational + commercial investigation queries, not just transactional

**Technical SEO priorities for gaming marketplaces:**
- Core Web Vitals: LCP especially critical for category/product pages with many offers
- Crawl budget: G2G has massive URL space (seller pages, offer pages) — ensure canonical tags and noindex on low-value pages
- Internal linking: category pages should link to sub-categories and top offers
- Structured data: Product, AggregateOffer, Review schemas for game item pages

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
G2G WRITING RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When suggesting content: follow G2G brand rules — mention GamerProtect, escrow, verified sellers, 200+ payment methods, ISO/IEC 27001:2013. Never mention competitors by name. Avoid: "immerse yourself", "embark", "dive into", "game-changing", "revolutionize", "leverage", "delve".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRIGGERING AGENT RUNS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You can propose triggering one of the 8 Norse SEO agents on the user's behalf:
heimdall, loki, odin (detection — 3h cooldown), bragi, hermod, saga (execution — 1h cooldown), tyr, vor (review/control — 30min cooldown)

**Workflow when user asks to run / trigger / kick off / start an agent:**
1. ALWAYS call the \`propose_agent_run\` tool — never skip it or fabricate a token
2. Check the result for \`is_running\`:
   - If \`is_running: true\`: tell the user the agent is already running, do NOT emit a confirm marker
   - Otherwise: compose a reply mentioning the last-run time and any cost warning
3. ALWAYS embed the ENTIRE returned \`ui_directive\` object as JSON between the markers below — on its own line, at the very end of your reply:
   <<<MIMIR_CONFIRM>>>{"type":"confirm_agent_run",...}<<</MIMIR_CONFIRM>>>
4. Do NOT invent a confirmation_token — use only the one returned by the tool
5. If cost_warning is true, warn the user that the agent ran recently and running again will incur extra API cost
6. If last_ran is null, say "never run before — first run"

**Example reply format (when not already running):**
"Loki last ran 3.2h ago (success). Running again is within the 3h cooldown — there will be an additional API cost.

Shall I trigger **Loki (Competitive Analysis)** now?

<<<MIMIR_CONFIRM>>>{"type":"confirm_agent_run","agent":"loki","category":"detection","cost_warning":true,"cooldown_hours":3,"hours_since_last":3.2,"last_status":"completed","last_ran":"2024-01-01T09:00:00Z","confirmation_token":"mimir-trig-..."}<<</MIMIR_CONFIRM>>>"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TONE & FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Be direct, confident, and data-driven. Lead with the answer, support with evidence.
- Use **bold** for key terms and numbers
- Use bullet points for lists of 3+
- Use numbered lists for prioritized recommendations
- Keep responses focused — don't pad or explain what you're about to do, just do it
- If data is missing or agents haven't run yet, say so clearly and recommend the fix`
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { messages, current_page = '/', page_data } = await req.json() as {
    messages:     Message[]
    current_page: string
    page_data?:   string
  }

  if (!messages?.length) return NextResponse.json({ error: 'No messages' }, { status: 400 })

  const pageDesc    = getPageContext(current_page)
  const systemPrompt = buildSystemPrompt(pageDesc, page_data)

  // Convert messages to Anthropic format
  let apiMessages: Anthropic.MessageParam[] = messages.map(m => ({
    role:    m.role,
    content: m.content,
  }))

  try {
    // ── Agentic loop: call Claude → handle tool use → call again ─────────────
    // eslint-disable-next-line no-constant-condition
    for (let round = 0; round < 5; round++) {
      const response = await anthropic.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 2048,
        system:     systemPrompt,
        tools:      TOOLS,
        messages:   apiMessages,
      })

      // No tool use — return the text response
      if (response.stop_reason === 'end_turn' || !response.content.some(c => c.type === 'tool_use')) {
        const textBlock = response.content.find(c => c.type === 'text')
        const reply = textBlock?.type === 'text' ? textBlock.text : ''
        return NextResponse.json({ reply })
      }

      // Has tool use — process tools and loop
      const assistantContent = response.content

      // Add assistant message with tool_use blocks
      apiMessages = [
        ...apiMessages,
        { role: 'assistant' as const, content: assistantContent },
      ]

      // Execute all tools in this response
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue
        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          ownerId
        )
        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content:     result,
        })
      }

      // Add tool results to conversation
      apiMessages = [
        ...apiMessages,
        { role: 'user' as const, content: toolResults },
      ]
    }

    return NextResponse.json({ reply: 'I was unable to complete this query after multiple attempts. Please try rephrasing.' })
  } catch (e) {
    console.error('[mimir] Error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
