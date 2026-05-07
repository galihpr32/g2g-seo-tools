// ─── Mimir's Council — experiment ideation agent ────────────────────────────
//
// Mimir is the Norse god of wisdom — drinker from the well of knowledge,
// adviser to the king. There's already a general "Mimir The All Knowing"
// chatbot at /api/ai/chat (codebase Q&A). This file implements a SECOND,
// specialized Mimir surface focused exclusively on experiment ideation
// for the Start/Stop/Continue tracker.
//
// Why split? The chatbot is general-purpose; this Council is tightly
// scoped: every reply either generates idea PROPOSALS (parsed into
// fenced JSON blocks the UI can turn into experiments with one click)
// or analyzes data the user surfaces. The system prompt enforces that
// shape, which the general chatbot doesn't.
//
// Mimir's data inputs:
//   - Recent monthly + weekly report data
//   - Tracked-product ranking history (poorly-ranked keywords)
//   - Site audit findings (most recent on-page issues)
//   - Currently running + past experiments (avoid duplication, learn from failure)

import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Sonnet because ideation benefits from broader reasoning. Haiku is too
// quick to propose generic ideas; Opus is overkill for chat.
const MIMIR_MODEL = 'claude-sonnet-4-6'

export interface MimirCouncilContext {
  siteSlug:     string
  siteName:     string                            // 'G2G' / 'OffGamers'
  domain:       string                            // 'g2g.com'

  recentMonthly?: {
    monthLabel:    string
    summary:       string
    topGainerPages?: string[]
    topDropperPages?: string[]
    pctChange?:    { clicks?: number; sessions?: number; conversions?: number; revenue?: number }
  }
  recentWeekly?: {
    weekStart:     string
    summary:       string
  }

  poorlyRanked?: {
    keyword:       string
    productName:   string
    avgPosition:   number
    movement30d:   number | null    // negative = improved, positive = dropped
  }[]

  auditFindings?: {
    issue:         string
    pageCount:     number
    severity:      'high' | 'medium' | 'low'
  }[]

  activeExperiments?: {
    title:         string
    hypothesis:    string | null
    period:        string
    status:        string
  }[]

  pastExperiments?: {
    title:         string
    outcome:       string | null
    decisionNotes: string | null
  }[]
}

export interface ExperimentProposal {
  title:           string
  hypothesis:      string
  category:        'on-page' | 'content' | 'technical' | 'links' | 'experimentation'
  successMetric:   string
  baselineValue?:  number
  targetValue?:    number
  linkedKeywords?: string[]
  linkedPages?:    string[]
  confidence:      1 | 2 | 3 | 4 | 5
  effort:          1 | 2 | 3 | 4 | 5
}

export interface MimirChatMessage {
  role:    'user' | 'assistant' | 'system'
  content: string
  ts?:     string
  proposals?: ExperimentProposal[]
}

// ─── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(c: MimirCouncilContext): string {
  const active = c.activeExperiments?.length
    ? c.activeExperiments.map(e => `  • [${e.status.toUpperCase()}] ${e.title} (since ${e.period})${e.hypothesis ? ` — ${e.hypothesis}` : ''}`).join('\n')
    : '  (none yet)'

  const past = c.pastExperiments?.length
    ? c.pastExperiments.slice(0, 6).map(e =>
        `  • ${e.title} → ${e.outcome ?? 'n/a'}${e.decisionNotes ? ` (lesson: ${e.decisionNotes})` : ''}`).join('\n')
    : '  (none yet)'

  const poorlyRanked = c.poorlyRanked?.length
    ? c.poorlyRanked.slice(0, 12).map(p =>
        `  • "${p.keyword}" → pos ${p.avgPosition.toFixed(0)} on ${p.productName}${p.movement30d != null ? ` (30d: ${p.movement30d > 0 ? '↓' : '↑'}${Math.abs(p.movement30d)})` : ''}`).join('\n')
    : '  (no tracked-product ranking data yet — encourage the user to add some)'

  const audit = c.auditFindings?.length
    ? c.auditFindings.slice(0, 8).map(a => `  • [${a.severity}] ${a.issue} (${a.pageCount} pages)`).join('\n')
    : '  (no recent audit data)'

  const monthly = c.recentMonthly
    ? `Most recent monthly (${c.recentMonthly.monthLabel}):
${c.recentMonthly.summary.slice(0, 1500)}
KPI deltas: ${JSON.stringify(c.recentMonthly.pctChange ?? {})}
Top gainer pages: ${(c.recentMonthly.topGainerPages ?? []).slice(0, 4).join(', ') || 'n/a'}
Top dropper pages: ${(c.recentMonthly.topDropperPages ?? []).slice(0, 4).join(', ') || 'n/a'}`
    : '(no recent monthly report — user should generate one first)'

  const weekly = c.recentWeekly
    ? `Most recent weekly (week of ${c.recentWeekly.weekStart}):
${c.recentWeekly.summary.slice(0, 800)}`
    : '(no recent weekly report)'

  return `You are MIMIR — the Norse god of wisdom — convening your Council to advise the user, who runs SEO for ${c.siteName} (${c.domain}).

This Council session has ONE purpose: help the user generate experiment IDEAS for their monthly Start/Stop/Continue framework. You don't run the experiments — the user does. You don't predict the future — you ground every idea in the data shown below.

YOUR PERSONALITY:
- Wise but pragmatic. Quote a number. Avoid vague advice ("improve content quality" is forbidden; "add 3 FAQ blocks to the wow-classic-era-vanilla-gold page where 'wow gold trade' has dropped from pos 8 → 14" is the bar).
- Honest about uncertainty. When proposing speculative ideas, say so plainly.
- Mildly poetic — you may invoke imagery (rivers of clicks, the well of impressions) sparingly to keep things memorable, but never at the cost of clarity.
- Bilingual: respond in Indonesian when the user writes in Indonesian; English when English. Match register (casual vs formal).

DATA YOU HAVE:

[Monthly report context]
${monthly}

[Weekly report context]
${weekly}

[Poorly-ranked tracked-product keywords]
${poorlyRanked}

[Site audit findings (most recent)]
${audit}

[Currently running experiments — DO NOT duplicate]
${active}

[Past experiments + outcomes — LEARN from these, especially the failures]
${past}

YOUR OUTPUT FORMAT:

When the user asks for experiment ideas, you respond with up to 5 proposals. Each proposal MUST be wrapped in a fenced JSON block like this:

\`\`\`experiment
{
  "title": "Short imperative title",
  "hypothesis": "Why this will move the metric (1-2 sentences, cite the data)",
  "category": "on-page | content | technical | links | experimentation",
  "successMetric": "Specific measurable outcome (e.g. 'Avg pos for [kw] improves from 14 to ≤8 within 30 days')",
  "baselineValue": <number or null>,
  "targetValue": <number or null>,
  "linkedKeywords": ["kw1", "kw2"],
  "linkedPages": ["/categories/wow-gold"],
  "confidence": 1-5,
  "effort": 1-5
}
\`\`\`

Each fenced block must be valid JSON parseable by JSON.parse. Wrap commentary text around blocks freely — the UI strips between-block prose for parsing but shows it to the user.

When the user asks ANALYTICAL questions (not "give me ideas"), respond conversationally without proposal blocks.

When the user wants to refine an existing idea ("make it more specific", "what if we focus on mobile"), reply with ONE fenced experiment block + commentary.

If the data is thin (e.g. only 2 keywords tracked), say so plainly and propose 1-2 ideas grounded in what little we have plus a request for more data.

NEVER propose ideas you don't have evidence for.`
}

// ─── Public: chat with Mimir's Council ──────────────────────────────────────

export async function chatWithMimirCouncil(opts: {
  context:  MimirCouncilContext
  history:  MimirChatMessage[]
  userMessage: string
}): Promise<{ reply: string; proposals: ExperimentProposal[] }> {
  const { context, history, userMessage } = opts

  const anthropicMessages: Anthropic.MessageParam[] = []
  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      anthropicMessages.push({ role: m.role, content: m.content })
    }
  }
  anthropicMessages.push({ role: 'user', content: userMessage })

  const res = await anthropic.messages.create({
    model:      MIMIR_MODEL,
    max_tokens: 2400,
    system:     buildSystemPrompt(context),
    messages:   anthropicMessages,
  })

  const reply = res.content[0]?.type === 'text' ? res.content[0].text : ''
  const proposals = parseProposals(reply)

  return { reply, proposals }
}

// ─── Parsing helper ──────────────────────────────────────────────────────────
// Tolerant: skip malformed proposals so one bad block doesn't lose the rest.

const FENCE_RE = /```experiment\s*([\s\S]+?)```/g

function parseProposals(text: string): ExperimentProposal[] {
  const out: ExperimentProposal[] = []
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim())
      if (typeof obj.title === 'string' && typeof obj.hypothesis === 'string') {
        out.push({
          title:          String(obj.title).trim(),
          hypothesis:     String(obj.hypothesis).trim(),
          category:       (['on-page','content','technical','links','experimentation'].includes(obj.category) ? obj.category : 'experimentation') as ExperimentProposal['category'],
          successMetric:  String(obj.successMetric ?? '').trim(),
          baselineValue:  typeof obj.baselineValue === 'number' ? obj.baselineValue : undefined,
          targetValue:    typeof obj.targetValue   === 'number' ? obj.targetValue   : undefined,
          linkedKeywords: Array.isArray(obj.linkedKeywords) ? obj.linkedKeywords.filter((k: unknown) => typeof k === 'string') : [],
          linkedPages:    Array.isArray(obj.linkedPages)    ? obj.linkedPages.filter((k: unknown) => typeof k === 'string')    : [],
          confidence:     clampInt(obj.confidence, 1, 5) as ExperimentProposal['confidence'],
          effort:         clampInt(obj.effort, 1, 5) as ExperimentProposal['effort'],
        })
      }
    } catch {
      // skip malformed
    }
  }
  return out
}

function clampInt(n: unknown, lo: number, hi: number): number {
  const v = Number(n)
  if (Number.isNaN(v)) return lo
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

// ─── Context loader — pulls everything Mimir needs from the DB ──────────────

export async function loadMimirCouncilContext(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any, any, any>
  ownerId:   string
  siteSlug:  string
  siteName:  string
  domain:    string
}): Promise<MimirCouncilContext> {
  const { db, ownerId, siteSlug, siteName, domain } = opts

  // Recent monthly
  const { data: monthlyRow } = await db
    .from('monthly_reports')
    .select('month_start, ai_narrative, report_data')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('month_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  const recentMonthly = monthlyRow ? {
    monthLabel: String(monthlyRow.report_data?.monthLabel ?? monthlyRow.month_start),
    summary:    String(monthlyRow.ai_narrative ?? '').slice(0, 1500),
    topGainerPages:  (monthlyRow.report_data?.gsc?.topGainers ?? []).slice(0, 4).map((g: { page: string }) => g.page),
    topDropperPages: (monthlyRow.report_data?.gsc?.topDroppers ?? []).slice(0, 4).map((g: { page: string }) => g.page),
    pctChange: {
      clicks:      monthlyRow.report_data?.gsc?.clicksPct ?? undefined,
      sessions:    monthlyRow.report_data?.ga4?.sessionsPct ?? undefined,
      conversions: monthlyRow.report_data?.ga4?.conversionsPct ?? undefined,
      revenue:     monthlyRow.report_data?.ga4?.revenuePct ?? undefined,
    },
  } : undefined

  // Recent weekly
  const { data: weeklyRow } = await db
    .from('weekly_reports')
    .select('week_start, ai_narrative')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('week_start', { ascending: false })
    .limit(1)
    .maybeSingle()

  const recentWeekly = weeklyRow ? {
    weekStart: String(weeklyRow.week_start),
    summary:   String(weeklyRow.ai_narrative ?? '').slice(0, 800),
  } : undefined

  // Poorly-ranked tracked-product keywords (avg position over last 30d > 10)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0]
  const { data: rankRows } = await db
    .from('keyword_ranking_history')
    .select('keyword, position, snapshot_date, tracked_product_id')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .gte('snapshot_date', since)
    .order('snapshot_date', { ascending: true })

  // Need product names — fetch separately for active products on this site
  const { data: prodRows } = await db
    .from('tracked_products')
    .select('id, name')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)

  const prodNameById = new Map<string, string>(
    (prodRows ?? []).map(p => [String(p.id), String(p.name)])
  )

  type RankRow = { keyword: string; position: number | null; snapshot_date: string; tracked_product_id: string }
  const rankMap = new Map<string, { keyword: string; productName: string; positions: number[]; first: number | null; last: number | null }>()
  for (const r of (rankRows ?? []) as RankRow[]) {
    const key = `${r.tracked_product_id}|${r.keyword}`
    const productName = prodNameById.get(String(r.tracked_product_id)) ?? '?'
    const entry = rankMap.get(key) ?? { keyword: r.keyword, productName, positions: [], first: null, last: null }
    if (r.position != null) {
      entry.positions.push(r.position)
      if (entry.first == null) entry.first = r.position
      entry.last = r.position
    }
    rankMap.set(key, entry)
  }

  const poorlyRanked = Array.from(rankMap.values())
    .filter(r => r.positions.length >= 1)
    .map(r => {
      const avg = r.positions.reduce((s, n) => s + n, 0) / r.positions.length
      const movement30d = (r.first != null && r.last != null) ? r.last - r.first : null
      return {
        keyword:     r.keyword,
        productName: r.productName,
        avgPosition: avg,
        movement30d,
      }
    })
    .filter(r => r.avgPosition > 10)
    .sort((a, b) => b.avgPosition - a.avgPosition)
    .slice(0, 12)

  // Active + past experiments
  const { data: activeExp } = await db
    .from('experiments')
    .select('title, hypothesis, period_started, status')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .in('status', ['start', 'continue'])
    .order('updated_at', { ascending: false })
    .limit(20)

  const { data: pastExp } = await db
    .from('experiments')
    .select('title, outcome, decision_notes')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .eq('status', 'stop')
    .order('updated_at', { ascending: false })
    .limit(8)

  return {
    siteSlug,
    siteName,
    domain,
    recentMonthly,
    recentWeekly,
    poorlyRanked,
    auditFindings: [],     // wired in a future pass — needs DFS audit history aggregation
    activeExperiments: (activeExp ?? []).map(e => ({
      title:      String(e.title),
      hypothesis: e.hypothesis as string | null,
      period:     String(e.period_started),
      status:     String(e.status),
    })),
    pastExperiments: (pastExp ?? []).map(e => ({
      title:         String(e.title),
      outcome:       e.outcome as string | null,
      decisionNotes: e.decision_notes as string | null,
    })),
  }
}
