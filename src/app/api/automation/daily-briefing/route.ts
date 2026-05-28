import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

/**
 * GET  /api/automation/daily-briefing  — triggered by Vercel Cron (schedule: "0 0 * * 1-5")
 * POST /api/automation/daily-briefing  — triggered by external cron services (e.g. cron-job.org)
 *
 * Composes a mixed-audience daily pipeline briefing for #writer-rangers.
 * Sections:
 *   1. 📝 Writer Queue       — briefs ready to write, in-progress, recently published
 *   2. 🚦 SEO Pipeline       — opp queue, agent activity, stuck items
 *   3. 📊 Team Activity      — yesterday's contributions per user
 *
 * Auth: Bearer CRON_SECRET
 *   - Vercel Cron injects this automatically via CRON_SECRET env var (GET requests).
 *   - External cron services must send: Authorization: Bearer <CRON_SECRET>
 *
 * POST body (optional):
 *   {
 *     ownerUserId?: string   (default: G2G_OWNER_USER_ID env)
 *     siteSlug?:    string   (default: 'g2g')
 *     preview?:     boolean  (default: false — set true to skip Slack post)
 *   }
 *
 * Returns: { ok, markdown, slackTs, dataSnapshot, generatedAt }
 */

export const maxDuration = 60

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-haiku-4-5-20251001'

function isCronAuth(request: Request): boolean {
  const authHeader = request.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

/** GET — called by Vercel Cron. Uses default params (no body). */
export async function GET(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return runBriefing({ ownerUserId: undefined, siteSlug: undefined, preview: false })
}

/** POST — called by external cron services (cron-job.org, EasyCron, etc.). Accepts optional body. */
export async function POST(request: Request) {
  if (!isCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({})) as {
    ownerUserId?: string
    siteSlug?:    string
    preview?:     boolean
  }

  return runBriefing(body)
}

async function runBriefing(body: { ownerUserId?: string; siteSlug?: string; preview?: boolean }) {
  const ownerId  = body.ownerUserId ?? process.env.G2G_OWNER_USER_ID
  const siteSlug = body.siteSlug    ?? 'g2g'
  const preview  = body.preview     ?? false

  if (!ownerId) {
    return NextResponse.json({
      error: 'ownerUserId required — set G2G_OWNER_USER_ID env var or pass in body',
    }, { status: 400 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  try {
    // 1. Gather all data we need (parallel fetches)
    const data = await gatherBriefingData(db, ownerId, siteSlug)

    // 2. Compose markdown via Claude (mixed-audience, Slack-flavored)
    const markdown = await composeBriefing(data)

    // 3. Post to Slack unless preview mode
    let slackTs: string | null = null
    if (!preview && process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID) {
      slackTs = await postToSlack(markdown)
    }

    return NextResponse.json({
      ok:           true,
      markdown,
      slackTs,
      dataSnapshot: data,
      generatedAt:  new Date().toISOString(),
    })
  } catch (err) {
    console.error('[daily-briefing] failed:', err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

// ─── Data gathering ──────────────────────────────────────────────────────────

interface BriefingData {
  date:               string
  pipelineCounts:     Record<string, number>   // status → count
  needActionTop3:     Array<{ topic: string; total_sv: number | null; signal_count: number }>
  briefsReady:        Array<{ keyword: string; brief_type: string; tyr_score: number | null }>
  briefsInProgress:   Array<{ keyword: string; assigned_to_email: string | null }>
  briefsPublishedY:   Array<{ keyword: string; published_by_email: string | null }>
  agentRuns:          Array<{ agent: string; status: string; summary: string; hours_ago: number }>
  stuckBriefs:        number
  yesterdayApprovals: Array<{ topic: string; approved_by_email: string | null }>
  yesterdayDismissals: Array<{ topic: string }>
  prospectsClaimed:   Array<{ domain: string; claimed_by_email: string | null }>
  topContributorY:    string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = any

async function gatherBriefingData(
  db: SupabaseDb,
  ownerId: string,
  siteSlug: string,
): Promise<BriefingData> {
  // Yesterday range: 24-hour window ending at midnight UTC today
  const todayStartUtc      = new Date()
  todayStartUtc.setUTCHours(0, 0, 0, 0)
  const yesterdayStartUtc  = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000)
  const last24hUtc         = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [oppsRes, briefsRes, runsRes, prospectsRes, membersRes] = await Promise.all([
    db.from('seo_opportunities')
      .select('id, topic, status, total_sv, signal_count, approved_by, approved_at, dismissed_by, dismissed_at, brief_id, updated_at')
      .eq('owner_user_id', ownerId)
      .eq('site_slug', siteSlug)
      .order('updated_at', { ascending: false })
      .limit(120),

    db.from('seo_content_briefs')
      .select('id, primary_keyword, brief_type, status, tyr_status, tyr_score, claude_review_status, published_at, published_by, assigned_to, updated_at')
      .eq('owner_user_id', ownerId)
      .order('updated_at', { ascending: false })
      .limit(120),

    db.from('agent_runs')
      .select('id, agent_key, status, summary, started_at')
      .eq('owner_user_id', ownerId)
      .gte('started_at', last24hUtc.toISOString())
      .order('started_at', { ascending: false })
      .limit(60),

    db.from('outreach_prospects')
      .select('domain, claimed_by, claimed_at, source_keyword')
      .eq('owner_user_id', ownerId)
      .gte('claimed_at', yesterdayStartUtc.toISOString())
      .limit(40),

    db.from('workspace_members')
      .select('member_user_id, member_email')
      .eq('owner_user_id', ownerId)
      .eq('status', 'active'),
  ])

  // Build user_id → email map for actor name resolution
  type MemberRow = { member_user_id: string | null; member_email: string | null }
  const userIdToEmail = new Map<string, string>()
  for (const m of (membersRes.data ?? []) as MemberRow[]) {
    if (m.member_user_id && m.member_email) userIdToEmail.set(m.member_user_id, m.member_email)
  }
  // Owner self-lookup via auth.users
  const { data: ownerAuth } = await db.auth.admin.getUserById(ownerId)
  if (ownerAuth?.user?.email) userIdToEmail.set(ownerId, ownerAuth.user.email)

  type OppRow = {
    id: string; topic: string; status: string;
    total_sv: number | null; signal_count: number | null;
    approved_by: string | null; approved_at: string | null;
    dismissed_by: string | null; dismissed_at: string | null;
    brief_id: string | null; updated_at: string;
  }
  type BriefRow = {
    id: string; primary_keyword: string | null; brief_type: string | null;
    status: string; tyr_status: string | null; tyr_score: number | null;
    claude_review_status: string | null;
    published_at: string | null; published_by: string | null;
    assigned_to: string | null; updated_at: string;
  }
  type RunRow = {
    id: string; agent_key: string; status: string; summary: string | null; started_at: string;
  }
  type ProspectRow = {
    domain: string; claimed_by: string | null; claimed_at: string | null; source_keyword: string | null;
  }

  const opps   = (oppsRes.data       ?? []) as OppRow[]
  const briefs = (briefsRes.data     ?? []) as BriefRow[]
  const runs   = (runsRes.data       ?? []) as RunRow[]
  const prosp  = (prospectsRes.data  ?? []) as ProspectRow[]

  // ── Pipeline counts by status (excluding dismissed)
  const pipelineCounts: Record<string, number> = {}
  for (const o of opps) {
    if (o.status === 'dismissed') continue
    pipelineCounts[o.status] = (pipelineCounts[o.status] ?? 0) + 1
  }

  // ── Top 3 Need Action (status='new', highest SV)
  const needActionTop3 = opps
    .filter(o => o.status === 'new')
    .sort((a, b) => (Number(b.total_sv) || 0) - (Number(a.total_sv) || 0))
    .slice(0, 3)
    .map(o => ({ topic: o.topic, total_sv: o.total_sv, signal_count: o.signal_count ?? 0 }))

  // ── Briefs READY to write: tyr_status='reviewed' AND claude passed/skipped AND not yet assigned
  const briefsReady = briefs
    .filter(b =>
      b.tyr_status === 'reviewed' &&
      (b.claude_review_status === 'passed' || b.claude_review_status === 'skipped') &&
      b.status !== 'published' &&
      !b.assigned_to,
    )
    .slice(0, 8)
    .map(b => ({
      keyword:    b.primary_keyword ?? '(untitled)',
      brief_type: b.brief_type ?? 'unknown',
      tyr_score:  b.tyr_score,
    }))

  // ── Briefs IN PROGRESS: assigned, not published yet
  const briefsInProgress = briefs
    .filter(b => b.assigned_to && b.status !== 'published')
    .slice(0, 6)
    .map(b => ({
      keyword:           b.primary_keyword ?? '(untitled)',
      assigned_to_email: b.assigned_to ? userIdToEmail.get(b.assigned_to) ?? null : null,
    }))

  // ── Briefs PUBLISHED yesterday (24h window)
  const briefsPublishedY = briefs
    .filter(b => b.published_at && new Date(b.published_at) >= yesterdayStartUtc)
    .map(b => ({
      keyword:            b.primary_keyword ?? '(untitled)',
      published_by_email: b.published_by ? userIdToEmail.get(b.published_by) ?? null : null,
    }))

  // ── Agent runs last 24h, condensed
  const agentRuns = runs.slice(0, 10).map(r => ({
    agent:    r.agent_key,
    status:   r.status,
    summary:  (r.summary ?? '').slice(0, 140),
    hours_ago: r.started_at ? (Date.now() - new Date(r.started_at).getTime()) / 3_600_000 : 0,
  }))

  // ── Stuck briefs: 'draft' or 'generating' >10 min
  const tenMinAgo = Date.now() - 10 * 60 * 1000
  const stuckBriefs = briefs.filter(b =>
    (b.status === 'draft' || b.status === 'generating') &&
    new Date(b.updated_at).getTime() < tenMinAgo,
  ).length

  // ── Yesterday approvals (per opp)
  const yesterdayApprovals = opps
    .filter(o => o.approved_at && new Date(o.approved_at) >= yesterdayStartUtc)
    .map(o => ({
      topic:             o.topic,
      approved_by_email: o.approved_by ? userIdToEmail.get(o.approved_by) ?? null : null,
    }))

  const yesterdayDismissals = opps
    .filter(o => o.dismissed_at && new Date(o.dismissed_at) >= yesterdayStartUtc)
    .map(o => ({ topic: o.topic }))

  // ── Prospects claimed yesterday
  const prospectsClaimed = prosp.map(p => ({
    domain:           p.domain,
    claimed_by_email: p.claimed_by ? userIdToEmail.get(p.claimed_by) ?? null : null,
  }))

  // ── Top contributor yesterday (by total actions)
  const contribCounts = new Map<string, number>()
  for (const a of yesterdayApprovals) {
    if (a.approved_by_email) contribCounts.set(a.approved_by_email, (contribCounts.get(a.approved_by_email) ?? 0) + 1)
  }
  for (const b of briefsPublishedY) {
    if (b.published_by_email) contribCounts.set(b.published_by_email, (contribCounts.get(b.published_by_email) ?? 0) + 1)
  }
  for (const p of prospectsClaimed) {
    if (p.claimed_by_email) contribCounts.set(p.claimed_by_email, (contribCounts.get(p.claimed_by_email) ?? 0) + 1)
  }
  const topContributorY = Array.from(contribCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

  return {
    date: todayStartUtc.toISOString().split('T')[0],
    pipelineCounts,
    needActionTop3,
    briefsReady,
    briefsInProgress,
    briefsPublishedY,
    agentRuns,
    stuckBriefs,
    yesterdayApprovals,
    yesterdayDismissals,
    prospectsClaimed,
    topContributorY,
  }
}

// ─── Compose markdown via Claude ──────────────────────────────────────────────

async function composeBriefing(data: BriefingData): Promise<string> {
  const prompt = `You are composing a Daily Pipeline Briefing for the G2G SEO team's Slack channel #writer-rangers.

CONTEXT:
- Audience: mixed — writers, SEO specialists, and managers all read this together.
- Tone: warm but professional. Mix Indonesian and English naturally (team is Indonesian, but technical terms stay English).
- Format: Slack mrkdwn (NOT standard markdown):
  - Bold: *single asterisks* (NOT **double**)
  - Italic: _underscores_
  - Bullets: leading "• " (NOT "-" or "*")
  - Headers: bold lines, NO "#" syntax
  - Links: <url|label>
- Length: 200-350 words total. Tight, scannable, not a wall of text.
- Today's date: ${data.date}

STRUCTURE — exactly 3 sections, in this order:

*📝 Writer Queue*
What writers should pick up today. Mention concrete brief keywords (top 2-3). If nothing ready, say so honestly. Mention assignments-in-progress if any.

*🚦 SEO Pipeline*
Pipeline health snapshot. Need Action queue (top topic by SV), agent activity highlights (1-2 notable runs from last 24h, only if interesting — skip if boring/repetitive), any stuck items that need attention.

*📊 Team Activity*
Yesterday recap. Counts of opps approved, briefs published, prospects claimed. Shout out top contributor by name (use first name only, e.g. "Galih"). Skip if zero activity yesterday.

End with one short, punchy line — a recommended priority for today (e.g. "Fokus hari ini: 2 brief siap, 5 opp Need Action — clear queue dulu.").

Avoid:
- Generic motivation phrases ("Let's crush it!", "Great job team!").
- Repeating data unnecessarily.
- Mentioning agent jargon (Heimdall/Loki/Tyr) to writers — writers don't care, just say "agents found X new opps overnight".

Today's data:
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

Output the briefing now (Slack mrkdwn only, no preamble or explanation).`

  const resp = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  })

  const out = resp.content[0]
  return out.type === 'text' ? out.text.trim() : '(briefing composer returned non-text)'
}

// ─── Slack post ──────────────────────────────────────────────────────────────

async function postToSlack(text: string): Promise<string | null> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID,
      text,
      mrkdwn:  true,
    }),
  })

  const data = await res.json() as { ok: boolean; ts?: string; error?: string }
  if (!data.ok) {
    console.error('[daily-briefing] Slack post failed:', data.error)
    return null
  }
  return data.ts ?? null
}
