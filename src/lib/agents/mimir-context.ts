// ─── Mimir Level B — page-aware context loaders ───────────────────────────
//
// Mimir is one Sonnet-backed agent, but the data it sees (and the persona it
// adopts) shifts based on WHICH page the user opened it on. This module
// dispatches `page_context.kind` to a kind-specific loader that returns:
//   1. A system prompt that tells Mimir who they are RIGHT NOW
//   2. A pre-loaded data snapshot the user will likely ask about
//
// All loaders share the same TYPE (PageContextResult) so the chat route
// doesn't care which kind it's running.
//
// Adding a new page? Add a `kind` to PageContextKind, write a loader, register
// in the dispatch table at the bottom. Done.

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadMimirCouncilContext, buildExperimentsCouncilPrompt } from '@/lib/agents/mimir-council'

export type PageContextKind =
  | 'experiments'
  | 'monthly_report'
  | 'weekly_report'
  | 'opportunities'
  | 'ranking_drops'
  | 'brief'

export interface PageContext {
  kind: PageContextKind
  id?: string
  filter?: string
  since?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any
}

export interface PageContextResult {
  /** Persona + scope-setting system prompt — fed to Sonnet as `system`. */
  systemPrompt:    string
  /** Short label for the chat UI ("Mimir on April Monthly Report"). */
  contextLabel:    string
  /** Suggested quick prompts to seed the empty-state UI. */
  quickPrompts:    string[]
  /** Whether this kind supports parsing fenced ```experiment proposals.
   *  Only experiments page does — others get conversational replies only. */
  parseProposals:  boolean
}

// ─── Common header — every page-context wraps this ──────────────────────────

function commonPersonaHeader(opts: { siteName: string; domain: string }): string {
  return `You are MIMIR, the Norse god of wisdom — drinking from the well of knowledge to advise the user, who runs SEO for ${opts.siteName} (${opts.domain}).

PERSONALITY:
- Wise but pragmatic. Quote a number. Avoid vague advice ("improve content quality" is forbidden).
- Honest about uncertainty. When data is thin, say so plainly.
- Mildly poetic — invoke imagery (rivers of clicks, the well of impressions) sparingly to be memorable, never at the cost of clarity.
- Bilingual: respond in Indonesian when the user writes in Indonesian; English when English. Match register (casual vs formal).`
}

// ─── Loaders ────────────────────────────────────────────────────────────────

interface LoaderOpts {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>
  ownerId:   string
  siteSlug:  string
  siteName:  string
  domain:    string
  ctx:       PageContext
}

// 1. Experiments — delegate to existing Mimir Council context (kept stable
//    for backward compat with /api/experiments/mimir route).
async function loadExperimentsContext(opts: LoaderOpts): Promise<PageContextResult> {
  const baseCtx = await loadMimirCouncilContext(opts)
  return {
    systemPrompt:   buildExperimentsCouncilPrompt(baseCtx),
    contextLabel:   'Mimir\'s Council — Experiment ideation',
    quickPrompts: [
      'Generate 3 experiment ideas based on the latest report',
      'What should I test for low-CTR keywords?',
      'Suggest a quick-win experiment I can ship in 1 week',
      'Analyze why keyword X dropped (paste the data)',
    ],
    parseProposals: true,
  }
}

// 2. Monthly report — Mimir explains numbers + suggests drill-downs
async function loadMonthlyReportContext(opts: LoaderOpts): Promise<PageContextResult> {
  const reportId = opts.ctx.id
  let report:
    | { month_label: string; ai_narrative: string; report_data: Record<string, unknown> }
    | null = null

  if (reportId) {
    const { data } = await opts.db
      .from('monthly_reports')
      .select('month_start, ai_narrative, report_data')
      .eq('id', reportId)
      .eq('owner_user_id', opts.ownerId)
      .eq('site_slug', opts.siteSlug)
      .maybeSingle()
    if (data) {
      report = {
        month_label:  String((data.report_data as { monthLabel?: string })?.monthLabel ?? data.month_start),
        ai_narrative: String(data.ai_narrative ?? ''),
        report_data:  (data.report_data as Record<string, unknown>) ?? {},
      }
    }
  }

  const reportBlock = report
    ? `MONTHLY REPORT — ${report.month_label}

NARRATIVE (already drafted for the report):
${report.ai_narrative.slice(0, 2000)}

KEY METRICS (raw report_data fields you can cite):
${JSON.stringify({
  gsc:      (report.report_data.gsc as Record<string, unknown> | null) ?? null,
  ga4:      (report.report_data.ga4 as Record<string, unknown> | null) ?? null,
  channel:  (report.report_data.channelBreakdown as Record<string, unknown> | null) ?? null,
  rankings: (report.report_data.trackedRankings as Record<string, unknown> | null) ?? null,
}, null, 2).slice(0, 4000)}`
    : '(No specific report selected — user is browsing the report list.)'

  return {
    systemPrompt: `${commonPersonaHeader(opts)}

CURRENT PAGE: Monthly SEO Report viewer.
ROLE: Be a report companion. The user is reading the report and may want to:
  • Drill into a specific KPI ("why did revenue drop -17%?")
  • Cross-reference with another data source ("how does that compare to last quarter?")
  • Identify follow-up actions ("what should we do about this?")
  • Get a one-paragraph executive summary for slack/email

RULES:
- ALWAYS cite specific numbers from the metrics block when available.
- If the user asks "what should we do," propose 2-3 concrete actions, not generic advice.
- Don't fabricate metrics. If a number isn't in the data block, say "I don't see that in the report data."
- DO NOT generate experiment proposals here (that's the experiments page). Stay analytical.

${reportBlock}`,
    contextLabel: report ? `Mimir on ${report.month_label} Report` : 'Mimir — Monthly reports',
    quickPrompts: [
      'Summarize this report in 3 sentences for an exec',
      'What\'s the most concerning metric this month?',
      'Which channel underperformed and why?',
      'Suggest 3 things to investigate next',
    ],
    parseProposals: false,
  }
}

// 3. Weekly report — same shape, different table
async function loadWeeklyReportContext(opts: LoaderOpts): Promise<PageContextResult> {
  const reportId = opts.ctx.id
  let report:
    | { week_start: string; ai_narrative: string; report_data: Record<string, unknown> }
    | null = null

  if (reportId) {
    const { data } = await opts.db
      .from('weekly_reports')
      .select('week_start, ai_narrative, report_data')
      .eq('id', reportId)
      .eq('owner_user_id', opts.ownerId)
      .eq('site_slug', opts.siteSlug)
      .maybeSingle()
    if (data) {
      report = {
        week_start:   String(data.week_start),
        ai_narrative: String(data.ai_narrative ?? ''),
        report_data:  (data.report_data as Record<string, unknown>) ?? {},
      }
    }
  }

  const reportBlock = report
    ? `WEEKLY REPORT — week of ${report.week_start}

NARRATIVE (already drafted):
${report.ai_narrative.slice(0, 1800)}

METRICS:
${JSON.stringify({
  gsc:      (report.report_data.gsc as Record<string, unknown> | null) ?? null,
  ga4:      (report.report_data.ga4 as Record<string, unknown> | null) ?? null,
  rankings: (report.report_data.trackedRankings as Record<string, unknown> | null) ?? null,
}, null, 2).slice(0, 3500)}`
    : '(No specific weekly report selected.)'

  return {
    systemPrompt: `${commonPersonaHeader(opts)}

CURRENT PAGE: Weekly Pulse Report viewer.
ROLE: Quick-pulse companion. Weekly reports are tactical, not strategic — focus on:
  • Drops detected this week
  • Wins worth amplifying
  • Tomorrow's priorities
The user wants short, actionable answers. Avoid long narrative.

${reportBlock}`,
    contextLabel: report ? `Mimir on Week of ${report.week_start}` : 'Mimir — Weekly reports',
    quickPrompts: [
      'What\'s the #1 issue to address Monday morning?',
      'Quick wins from this week?',
      'Anything worth escalating to leadership?',
    ],
    parseProposals: false,
  }
}

// 4. Opportunities queue — Mimir helps prioritize
async function loadOpportunitiesContext(opts: LoaderOpts): Promise<PageContextResult> {
  // Pull recent unresolved findings/opportunities. We rely on agent_findings
  // since that's where Heimdall + Loki + Odin write.
  const { data: findings } = await opts.db
    .from('agent_findings')
    .select('agent_key, finding_type, subject, severity, data, created_at')
    .eq('owner_user_id', opts.ownerId)
    .eq('site_slug', opts.siteSlug)
    .gte('created_at', new Date(Date.now() - 14 * 86400_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(40)

  const findingsBlock = (findings ?? []).slice(0, 25).map(f => {
    const d = (f.data ?? {}) as Record<string, unknown>
    return `[${f.agent_key} · ${f.severity}] ${f.subject ?? f.finding_type} — ${JSON.stringify(d).slice(0, 200)}`
  }).join('\n') || '(no recent findings)'

  return {
    systemPrompt: `${commonPersonaHeader(opts)}

CURRENT PAGE: Opportunities queue.
ROLE: Triage advisor. Help the user pick which 5-10 opportunities to act on this sprint.

RECENT FINDINGS (last 14 days):
${findingsBlock}

RULES:
- Cite the specific finding (agent_key + subject) when recommending.
- Group by theme when helpful ("3 are about Q4 gold pages — bundle into one cluster build").
- Flag duplicates / patterns the user has likely seen before.
- Do NOT generate experiment proposals here.`,
    contextLabel: 'Mimir on Opportunities',
    quickPrompts: [
      'Pick top 5 opportunities for this week\'s sprint',
      'Are any of these duplicates of past work?',
      'Group these by theme',
      'Which findings should I escalate?',
    ],
    parseProposals: false,
  }
}

// 5. Ranking drops — Mimir diagnose
async function loadRankingDropsContext(opts: LoaderOpts): Promise<PageContextResult> {
  // Pull latest GSC drop snapshot (we don't have a single drop table — we
  // have ranking-impact + heimdall findings. Best signal: heimdall findings
  // tagged ranking_drop in last 7d).
  const { data: drops } = await opts.db
    .from('agent_findings')
    .select('subject, severity, data, created_at')
    .eq('owner_user_id', opts.ownerId)
    .eq('site_slug', opts.siteSlug)
    .eq('agent_key', 'heimdall')
    .gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString())
    .order('created_at', { ascending: false })
    .limit(20)

  const dropsBlock = (drops ?? []).map(d => {
    const data = (d.data ?? {}) as Record<string, unknown>
    return `[${d.severity}] ${d.subject} — ${JSON.stringify(data).slice(0, 250)}`
  }).join('\n') || '(no drops detected in the last 7 days)'

  return {
    systemPrompt: `${commonPersonaHeader(opts)}

CURRENT PAGE: Clicks Drop Alert.
ROLE: Drop diagnostician. The user sees a list of pages losing traffic — help them figure out:
  • What's likely the cause (recent edit / cannibalization / SERP shift / index issue / seasonal)
  • Whether to refresh content or restructure
  • What to check first (Page Analyzer / Cannibalization / Index Coverage)

RECENT DROPS (last 7 days, Heimdall findings):
${dropsBlock}

RULES:
- For each drop the user asks about, suggest a SPECIFIC diagnostic step + tool to use.
- If a pattern recurs across multiple pages, name the pattern.
- Don't propose new content — focus on RECOVERY of existing pages.`,
    contextLabel: 'Mimir on Ranking Drops',
    quickPrompts: [
      'What pattern do you see across these drops?',
      'Pick the highest-leverage drop to fix first',
      'Is this seasonal or structural?',
      'What diagnostic should I run?',
    ],
    parseProposals: false,
  }
}

// 6. Brief detail — Mimir as writing coach
async function loadBriefContext(opts: LoaderOpts): Promise<PageContextResult> {
  const briefId = opts.ctx.id
  let brief:
    | { primary_keyword: string | null; brief_type: string | null; tyr_score: number | null
        outline: unknown; faqs: unknown; content_draft: string | null }
    | null = null

  if (briefId) {
    const { data } = await opts.db
      .from('seo_content_briefs')
      .select('primary_keyword, brief_type, tyr_score, content_outline, faq_suggestions, content_draft, final_content')
      .eq('id', briefId)
      .eq('owner_user_id', opts.ownerId)
      .eq('site_slug', opts.siteSlug)
      .maybeSingle()
    if (data) {
      brief = {
        primary_keyword: data.primary_keyword as string | null,
        brief_type:      data.brief_type      as string | null,
        tyr_score:       data.tyr_score       as number | null,
        outline:         data.content_outline,
        faqs:            data.faq_suggestions,
        content_draft:   ((data.final_content ?? data.content_draft) as string | null),
      }
    }
  }

  const briefBlock = brief
    ? `BRIEF
keyword: ${brief.primary_keyword ?? '(unknown)'}
type: ${brief.brief_type ?? 'on_page'}
Tyr score: ${brief.tyr_score ?? '?'}/100
outline: ${JSON.stringify(brief.outline ?? []).slice(0, 1000)}
faqs: ${JSON.stringify(brief.faqs ?? []).slice(0, 800)}

DRAFT (first 2000 chars):
${(brief.content_draft ?? '').slice(0, 2000)}`
    : '(No brief loaded.)'

  return {
    systemPrompt: `${commonPersonaHeader(opts)}

CURRENT PAGE: Content brief detail.
ROLE: Writing coach. Help the writer/specialist:
  • Identify weak sections in the draft
  • Suggest specific FAQ additions / outline tweaks
  • Cross-reference against KB rules (avoid generic advice — quote the rule)
  • Spot patterns worth promoting to KB

${briefBlock}

RULES:
- Stay specific to THIS brief. Quote sections by heading.
- If the user asks "is this good enough?", answer based on Tyr score + observed gaps.
- Don't rewrite the entire brief unless asked. Surgical suggestions only.`,
    contextLabel: brief ? `Mimir on "${brief.primary_keyword ?? 'brief'}"` : 'Mimir — Brief detail',
    quickPrompts: [
      'What\'s the weakest part of this draft?',
      'Suggest 3 FAQ additions',
      'Is this brief ready to publish?',
      'Spot a pattern worth promoting to KB?',
    ],
    parseProposals: false,
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const LOADERS: Record<PageContextKind, (opts: LoaderOpts) => Promise<PageContextResult>> = {
  experiments:    loadExperimentsContext,
  monthly_report: loadMonthlyReportContext,
  weekly_report:  loadWeeklyReportContext,
  opportunities:  loadOpportunitiesContext,
  ranking_drops:  loadRankingDropsContext,
  brief:          loadBriefContext,
}

export async function loadPageContext(opts: LoaderOpts): Promise<PageContextResult> {
  const loader = LOADERS[opts.ctx.kind]
  if (!loader) {
    // Unknown kind — degrade to a safe generic prompt
    return {
      systemPrompt: `${commonPersonaHeader(opts)}\n\nCURRENT PAGE: Unknown.\nROLE: General SEO advisor. Answer the user's question with the data they paste in.`,
      contextLabel: 'Mimir',
      quickPrompts: [
        'Help me think through an SEO problem',
        'Analyze this data I\'m pasting',
      ],
      parseProposals: false,
    }
  }
  return loader(opts)
}
