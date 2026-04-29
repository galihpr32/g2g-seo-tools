import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET /api/pipeline-journey
 *
 * Returns opportunities enriched with their full pipeline stage data:
 * Detection signals → Aggregation → Triage status → Brief (Bragi+Tyr) →
 * Execute (writer) → Outreach (Hermod) → Measure (Vor).
 *
 * Query params:
 *   site     = site slug (default: g2g)
 *   status   = pipeline filter: all | needs_action | in_progress | completed (default: all)
 *   limit    = max rows (default 60)
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const db       = createServiceClient()
  const { searchParams } = new URL(req.url)
  const siteSlug = searchParams.get('site')   ?? 'g2g'
  const filter   = searchParams.get('status') ?? 'all'
  const limit    = Math.min(parseInt(searchParams.get('limit') ?? '60'), 200)

  // ── 1. Fetch opportunities (never show dismissed) ─────────────────────────
  const oppQuery = db
    .from('seo_opportunities')
    .select(`
      id, topic, topic_slug, target_url, status, output_type,
      signal_count, total_sv, created_at, updated_at, last_signal_at,
      brief_id, tyr_score, tyr_status,
      heimdall_signals, loki_signals, odin_signals
    `)
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .neq('status', 'dismissed')
    .order('updated_at', { ascending: false })
    .limit(limit)

  const { data: opps, error: oppErr } = await oppQuery
  if (oppErr) return NextResponse.json({ error: oppErr.message }, { status: 500 })
  if (!opps?.length) return NextResponse.json({ journey: [], stats: buildStats([]) })

  // ── 2. Batch-fetch briefs for opportunities that have one ─────────────────
  const briefIds = opps.map(o => o.brief_id).filter(Boolean) as string[]
  let briefMap: Record<string, BriefRow> = {}

  if (briefIds.length) {
    const { data: briefs } = await db
      .from('seo_content_briefs')
      .select(`
        id, status, tyr_status, tyr_score, keyword, word_count_target,
        target_publish_date, created_at, updated_at, notes
      `)
      .in('id', briefIds)
      .eq('owner_user_id', ownerId)

    for (const b of briefs ?? []) briefMap[b.id] = b
  }

  // ── 3. Batch-fetch brief_outcomes (Vor data) for those briefs ─────────────
  let outcomesMap: Record<string, OutcomeRow[]> = {}
  if (briefIds.length) {
    const { data: outcomes } = await db
      .from('brief_outcomes')
      .select('brief_id, checkpoint, position_before, position_after, clicks_before, clicks_after, snapshot_date')
      .in('brief_id', briefIds)
      .eq('owner_user_id', ownerId)
      .order('checkpoint', { ascending: true })

    for (const o of outcomes ?? []) {
      outcomesMap[o.brief_id] ??= []
      outcomesMap[o.brief_id].push(o)
    }
  }

  // ── 4. Batch-fetch outreach prospects via keyword matching ────────────────
  // Prospects link to opportunities via source_keyword ≈ opportunity topic
  const keywords = opps.map(o => o.topic).filter(Boolean)
  let prospectMap: Record<string, ProspectRow[]> = {}

  if (keywords.length) {
    const { data: prospects } = await db
      .from('outreach_prospects')
      .select('id, domain, source_keyword, status, created_at')
      .eq('owner_user_id', ownerId)
      .in('source_keyword', keywords)
      .order('created_at', { ascending: false })

    for (const p of prospects ?? []) {
      const key = p.source_keyword
      if (!key) continue
      prospectMap[key] ??= []
      prospectMap[key].push(p)
    }
  }

  // ── 5. Enrich into journey objects ────────────────────────────────────────
  const journey: JourneyItem[] = opps.map(opp => {
    const brief    = opp.brief_id ? briefMap[opp.brief_id]         : undefined
    const outcomes = opp.brief_id ? outcomesMap[opp.brief_id] ?? [] : []
    const prospects = prospectMap[opp.topic ?? ''] ?? []

    return buildJourneyItem(opp, brief, outcomes, prospects)
  })

  // Apply pipeline filter
  const filtered = filter === 'all' ? journey : journey.filter(j => {
    if (filter === 'needs_action') return j.needsAction
    if (filter === 'in_progress')  return j.pipelineStage >= 3 && !j.isComplete
    if (filter === 'completed')    return j.isComplete
    return true
  })

  return NextResponse.json({ journey: filtered, stats: buildStats(journey) })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface BriefRow {
  id: string; status: string; tyr_status: string | null; tyr_score: number | null
  keyword: string | null; word_count_target: number | null
  target_publish_date: string | null; created_at: string; updated_at: string
  notes: string | null
}

interface OutcomeRow {
  brief_id: string; checkpoint: number; position_before: number | null
  position_after: number | null; clicks_before: number | null
  clicks_after: number | null; snapshot_date: string | null
}

interface ProspectRow {
  id: string; domain: string; source_keyword: string | null
  status: string; created_at: string
}

export interface PipelineStageInfo {
  status:  'done' | 'active' | 'needs_action' | 'locked' | 'skipped'
  summary: string | null
  detail:  string | null
  agent:   string | null
  date:    string | null
  cta?:    { label: string; href: string; action?: string }
}

export interface JourneyItem {
  id:            string
  topic:         string
  topicSlug:     string | null
  targetUrl:     string | null
  oppStatus:     string
  signalCount:   number
  totalSv:       number | null
  createdAt:     string
  updatedAt:     string
  briefId:       string | null
  tyrScore:      number | null
  tyrStatus:     string | null
  heimdallCount: number
  lokiCount:     number
  odinCount:     number
  // Derived
  pipelineStage: number   // 1-7, current active stage
  progressPct:   number   // 0-100
  needsAction:   boolean
  isComplete:    boolean
  stages:        PipelineStageInfo[]
}

// ─── Builder ──────────────────────────────────────────────────────────────────

function buildJourneyItem(
  opp:       ReturnType<typeof Object.assign>,
  brief:     BriefRow | undefined,
  outcomes:  OutcomeRow[],
  prospects: ProspectRow[],
): JourneyItem {
  const heimdallCount = Array.isArray(opp.heimdall_signals) ? opp.heimdall_signals.length : (opp.heimdall_signals ? 1 : 0)
  const lokiCount     = Array.isArray(opp.loki_signals)     ? opp.loki_signals.length     : (opp.loki_signals     ? 1 : 0)
  const odinCount     = Array.isArray(opp.odin_signals)     ? opp.odin_signals.length     : (opp.odin_signals     ? 1 : 0)

  const stages = buildStages(opp, brief, outcomes, prospects, { heimdallCount, lokiCount, odinCount })

  // Active stage = first non-done stage
  const activeIdx = stages.findIndex(s => s.status !== 'done' && s.status !== 'skipped')
  const pipelineStage = activeIdx === -1 ? 7 : activeIdx + 1
  const doneCount = stages.filter(s => s.status === 'done').length
  const progressPct = Math.round((doneCount / stages.length) * 100)
  const needsAction = stages.some(s => s.status === 'needs_action')
  const isComplete  = stages.every(s => s.status === 'done' || s.status === 'skipped')

  return {
    id:            opp.id,
    topic:         opp.topic ?? '(untitled)',
    topicSlug:     opp.topic_slug,
    targetUrl:     opp.target_url,
    oppStatus:     opp.status,
    signalCount:   opp.signal_count ?? 0,
    totalSv:       opp.total_sv,
    createdAt:     opp.created_at,
    updatedAt:     opp.updated_at,
    briefId:       opp.brief_id,
    tyrScore:      opp.tyr_score,
    tyrStatus:     opp.tyr_status,
    heimdallCount, lokiCount, odinCount,
    pipelineStage, progressPct, needsAction, isComplete,
    stages,
  }
}

function buildStages(
  opp:       ReturnType<typeof Object.assign>,
  brief:     BriefRow | undefined,
  outcomes:  OutcomeRow[],
  prospects: ProspectRow[],
  counts:    { heimdallCount: number; lokiCount: number; odinCount: number },
): PipelineStageInfo[] {
  const { heimdallCount, lokiCount, odinCount } = counts
  const totalSignals = heimdallCount + lokiCount + odinCount
  const agentList = [
    heimdallCount ? 'Heimdall' : null,
    lokiCount     ? 'Loki'     : null,
    odinCount     ? 'Odin'     : null,
  ].filter(Boolean).join(' · ') || 'Agent'

  // ── Stage 1: Detection ────────────────────────────────────────────────────
  const stageDetection: PipelineStageInfo = {
    status:  'done',
    summary: `${totalSignals} signal${totalSignals !== 1 ? 's' : ''} detected`,
    detail:  [
      heimdallCount ? `Heimdall: ${heimdallCount} rank signal${heimdallCount !== 1 ? 's' : ''}` : null,
      lokiCount     ? `Loki: ${lokiCount} competitor gap${lokiCount !== 1 ? 's' : ''}`           : null,
      odinCount     ? `Odin: ${odinCount} keyword opportunity${odinCount !== 1 ? 's' : ''}`      : null,
    ].filter(Boolean).join(' · '),
    agent: agentList,
    date:  opp.created_at,
  }

  // ── Stage 2: Aggregation ──────────────────────────────────────────────────
  const stageAggregation: PipelineStageInfo = {
    status:  'done',
    summary: `Clustered into topic: "${opp.topic ?? 'Unknown'}"`,
    detail:  opp.total_sv ? `Est. search volume: ${Number(opp.total_sv).toLocaleString()}/mo` : null,
    agent:   'Saga',
    date:    opp.created_at,
  }

  // ── Stage 3: Triage ───────────────────────────────────────────────────────
  const isApproved = ['brief_queued', 'brief_ready', 'published'].includes(opp.status)
  const triageStatus: PipelineStageInfo['status'] =
    isApproved           ? 'done'         :
    opp.status === 'new' ? 'needs_action' : 'active'

  const stageTriage: PipelineStageInfo = {
    status:  triageStatus,
    summary: isApproved
      ? 'Approved — queued for brief generation'
      : `Score: ${opp.tyr_score ?? '—'} · Awaiting your decision`,
    detail: isApproved
      ? null
      : 'Review this opportunity and approve to generate a content brief, or dismiss if not relevant.',
    agent: null,
    date:  isApproved ? opp.updated_at : null,
    cta:   !isApproved ? { label: 'Approve → Brief', href: '/command-center/opportunities', action: 'approve' } : undefined,
  }

  // ── Stage 4: Brief (Bragi) ────────────────────────────────────────────────
  let stageBrief: PipelineStageInfo
  if (!isApproved) {
    stageBrief = { status: 'locked', summary: 'Waiting for triage approval', detail: null, agent: null, date: null }
  } else if (!brief) {
    stageBrief = {
      status:  'active',
      summary: 'Brief generation queued',
      detail:  'Bragi will generate the content brief automatically.',
      agent:   'Bragi',
      date:    null,
      cta:     { label: 'View in Brief Library', href: '/content/briefs' },
    }
  } else {
    const isGenerating = brief.status === 'generating'
    const isFailed = brief.tyr_status === 'failed'
    const isPassed = ['reviewed'].includes(brief.tyr_status ?? '')
    const briefStatus: PipelineStageInfo['status'] =
      isGenerating       ? 'active'       :
      isFailed           ? 'needs_action' :
      isPassed           ? 'done'         : 'done'

    stageBrief = {
      status:  briefStatus,
      summary: isGenerating
        ? 'Bragi is generating the brief…'
        : isFailed
          ? `Brief failed Tyr review (${brief.tyr_score ?? '?'}/100) — needs regeneration`
          : `Brief ready · ${brief.word_count_target ? brief.word_count_target + ' words' : ''} · Tyr ${brief.tyr_score ?? '?'}/100`,
      detail:  brief.keyword ? `Target keyword: "${brief.keyword}"` : null,
      agent:   'Bragi · Tyr',
      date:    brief.created_at,
      cta:     isFailed
        ? { label: 'Approve regeneration', href: '/command-center', action: 'regenerate' }
        : { label: 'View brief', href: `/content/briefs` },
    }
  }

  // ── Stage 5: Execute (writer) ─────────────────────────────────────────────
  let stageExecute: PipelineStageInfo
  const briefPublished = brief?.status === 'published'
  const briefReviewed  = brief?.tyr_status === 'reviewed' && brief?.status !== 'published'

  if (!brief || stageBrief.status === 'locked' || stageBrief.status === 'active') {
    stageExecute = { status: 'locked', summary: 'Waiting for approved brief', detail: null, agent: null, date: null }
  } else if (briefPublished) {
    stageExecute = {
      status:  'done',
      summary: 'Article published',
      detail:  null,
      agent:   'Writer',
      date:    brief.updated_at,
    }
  } else if (briefReviewed) {
    stageExecute = {
      status:  'needs_action',
      summary: 'Brief approved — ready to write',
      detail:  brief.target_publish_date ? `Target publish: ${brief.target_publish_date}` : 'No publish date set yet.',
      agent:   null,
      date:    null,
      cta:     { label: 'Open in Writer Inbox', href: '/content/writer-inbox' },
    }
  } else {
    stageExecute = {
      status:  'active',
      summary: 'In Writer Inbox',
      detail:  null,
      agent:   null,
      date:    null,
      cta:     { label: 'Open in Writer Inbox', href: '/content/writer-inbox' },
    }
  }

  // ── Stage 6: Outreach (Hermod) ────────────────────────────────────────────
  let stageOutreach: PipelineStageInfo
  if (!briefPublished) {
    stageOutreach = { status: 'locked', summary: 'Unlocks after article is published', detail: null, agent: null, date: null }
  } else if (!prospects.length) {
    stageOutreach = {
      status:  'active',
      summary: 'Hermod searching for outreach prospects…',
      detail:  'Runs automatically after publish. Check back after next Hermod cron.',
      agent:   'Hermod',
      date:    null,
    }
  } else {
    const accepted   = prospects.filter(p => ['accepted', 'published'].includes(p.status)).length
    const contacted  = prospects.filter(p => p.status === 'contacted').length
    const statusLine = [
      accepted  ? `${accepted} accepted`   : null,
      contacted ? `${contacted} contacted` : null,
    ].filter(Boolean).join(' · ') || `${prospects.length} prospects found`

    stageOutreach = {
      status:  accepted > 0 ? 'done' : 'needs_action',
      summary: statusLine,
      detail:  `${prospects.length} total prospect${prospects.length !== 1 ? 's' : ''} found`,
      agent:   'Hermod',
      date:    prospects[0]?.created_at ?? null,
      cta:     { label: 'View outreach', href: '/outreach' },
    }
  }

  // ── Stage 7: Measure (Vor) ────────────────────────────────────────────────
  let stageMeasure: PipelineStageInfo
  if (!briefPublished) {
    stageMeasure = { status: 'locked', summary: 'Unlocks after article is published', detail: null, agent: null, date: null }
  } else if (!outcomes.length) {
    stageMeasure = {
      status:  'active',
      summary: 'Vor tracking — first snapshot in ~30 days',
      detail:  'GSC data will be captured at publish day, +30d, +60d, +90d.',
      agent:   'Vor',
      date:    null,
    }
  } else {
    const latest = outcomes[outcomes.length - 1]
    const delta  = (latest.position_before ?? 0) - (latest.position_after ?? 0)
    const posStr = latest.position_after != null ? `Position: ${latest.position_after.toFixed(1)}` : null
    const deltaStr = delta !== 0 ? `(${delta > 0 ? '+' : ''}${delta.toFixed(1)} vs baseline)` : null

    stageMeasure = {
      status:  'done',
      summary: [posStr, deltaStr].filter(Boolean).join(' ') || `${outcomes.length} snapshot${outcomes.length !== 1 ? 's' : ''} captured`,
      detail:  `Checkpoint: +${latest.checkpoint}d`,
      agent:   'Vor',
      date:    latest.snapshot_date ?? null,
      cta:     { label: 'View ranking impact', href: '/reports/ranking-impact' },
    }
  }

  return [stageDetection, stageAggregation, stageTriage, stageBrief, stageExecute, stageOutreach, stageMeasure]
}

function buildStats(journey: JourneyItem[]) {
  return {
    total:       journey.length,
    needsAction: journey.filter(j => j.needsAction).length,
    inProgress:  journey.filter(j => !j.needsAction && !j.isComplete && j.pipelineStage >= 2).length,
    completed:   journey.filter(j => j.isComplete).length,
    byStage: {
      detection:   journey.filter(j => j.pipelineStage === 1).length,
      triage:      journey.filter(j => j.pipelineStage === 3).length,
      brief:       journey.filter(j => j.pipelineStage === 4).length,
      execute:     journey.filter(j => j.pipelineStage === 5).length,
      outreach:    journey.filter(j => j.pipelineStage === 6).length,
      measure:     journey.filter(j => j.pipelineStage === 7).length,
    }
  }
}
