import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { costForCall } from '@/lib/anthropic-pricing'

export const maxDuration = 30

/**
 * GET /api/system/health
 *
 * One-shot aggregate of every signal needed to know "is the system OK?".
 * Powers the /command-center/health page. All checks are scoped to the
 * effective owner (single-user assumption fine for internal G2G tool).
 *
 * Returns 6 sections:
 *  1. overall   — green/amber/red roll-up + "issues" array
 *  2. connections — GSC, GA4, Anthropic, Slack, DataForSEO creds presence
 *  3. crons     — last run + status of each scheduled job
 *  4. agents    — per-agent run counts + success rate (last 24h)
 *  5. dataFreshness — latest timestamp on key tables (gsc_drops, game_trends, serp_snapshots, briefs)
 *  6. recentErrors — top 10 failed runs/actions in last 7d
 *  7. budget    — Claude MTD spend + (optional) monthly budget threshold from env
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const now = Date.now()
  const dayAgoIso  = new Date(now -  24 * 60 * 60 * 1000).toISOString()
  const weekAgoIso = new Date(now -  7  * 24 * 60 * 60 * 1000).toISOString()
  const monthStartIso = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()

  // ── Run all checks in parallel ────────────────────────────────────────────
  const [
    gscConnRes,
    siteConfigsRes,
    agentRuns24Res,
    agentActions24Res,
    recentErrorsRes,
    rankingDropsLatestRes,
    gameTrendsLatestRes,
    serpSnapshotsLatestRes,
    briefsLatestRes,
    weeklyReportLatestRes,
    monthlyReportLatestRes,
    claudeUsageMtdRes,
  ] = await Promise.all([
    db.from('gsc_connections').select('site_url, expires_at, updated_at').eq('user_id', ownerId).maybeSingle(),
    db.from('site_configs').select('slug, ga4_property_id').eq('is_active', true),
    db.from('agent_runs').select('id, agent_key, status, started_at').eq('owner_user_id', ownerId).gte('started_at', dayAgoIso),
    db.from('agent_actions').select('id, status').eq('owner_user_id', ownerId).gte('created_at', dayAgoIso),
    db.from('agent_runs').select('id, agent_key, status, summary, error_message, started_at')
        .eq('owner_user_id', ownerId)
        .in('status', ['error', 'partial'])
        .gte('started_at', weekAgoIso)
        .order('started_at', { ascending: false })
        .limit(10),
    db.from('gsc_ranking_drops').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    db.from('game_trends_cache').select('cached_at').order('cached_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('serp_snapshots').select('snapshot_date').eq('owner_user_id', ownerId).order('snapshot_date', { ascending: false }).limit(1).maybeSingle(),
    db.from('seo_content_briefs').select('updated_at, status').eq('owner_user_id', ownerId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('weekly_reports').select('week_end, created_at').eq('owner_user_id', ownerId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('monthly_reports').select('month_end, created_at').eq('owner_user_id', ownerId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.from('api_usage_logs').select('endpoint, metadata, created_at').eq('owner_user_id', ownerId).eq('api_name', 'claude').gte('created_at', monthStartIso),
  ])

  // ── 2. Connections ────────────────────────────────────────────────────────
  const gscOk        = !!gscConnRes.data?.site_url
  const gscExpiresAt = gscConnRes.data?.expires_at as string | undefined
  const gscExpired   = gscExpiresAt ? new Date(gscExpiresAt).getTime() < now : false

  const ga4Configured = (siteConfigsRes.data ?? []).some(s => Boolean(s.ga4_property_id)) || Boolean(process.env.GA4_PROPERTY_ID)
  const slackOk       = Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID && process.env.SLACK_SIGNING_SECRET)
  const anthropicOk   = Boolean(process.env.ANTHROPIC_API_KEY)
  const dfsOk         = Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD)
  const semrushOk     = Boolean(process.env.SEMRUSH_API_KEY && process.env.SEMRUSH_API_KEY !== 'placeholder')

  const connections = [
    { name: 'GSC',        ok: gscOk && !gscExpired, detail: gscExpired ? `Token expired ${gscExpiresAt}` : gscConnRes.data?.site_url ?? 'Not connected' },
    { name: 'GA4',        ok: ga4Configured, detail: ga4Configured ? 'Configured' : 'No GA4_PROPERTY_ID set in env or site_configs' },
    { name: 'Anthropic',  ok: anthropicOk,   detail: anthropicOk ? 'API key set' : 'ANTHROPIC_API_KEY missing' },
    { name: 'DataForSEO', ok: dfsOk,         detail: dfsOk       ? 'Credentials set' : 'DATAFORSEO_LOGIN/PASSWORD missing' },
    { name: 'SEMrush',    ok: semrushOk,     detail: semrushOk   ? 'API key set' : 'SEMRUSH_API_KEY missing or placeholder' },
    { name: 'Slack',      ok: slackOk,       detail: slackOk     ? 'Bot token + signing secret set' : 'SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET missing' },
  ]

  // ── 3. Cron freshness ─────────────────────────────────────────────────────-
  // Strategy: each cron writes some data. We infer last run from the freshest
  // row of that data type. (No `cron_runs` table — keep it simple.)
  const latestDrop  = rankingDropsLatestRes.data?.snapshot_date as string | undefined
  const latestTrend = gameTrendsLatestRes.data?.cached_at as string | undefined

  const latestSchedulerRun = (agentRuns24Res.data ?? [])
    .map(r => r.started_at as string)
    .sort().reverse()[0]

  const crons = [
    {
      name:     'gsc-daily',
      lastRun:  latestDrop ? `${latestDrop}T00:00:00Z` : null,
      schedule: 'Vercel · 01:00 UTC daily',
      ok:       latestDrop ? (now - new Date(latestDrop).getTime()) < 36 * 60 * 60 * 1000 : false,
      note:     latestDrop ? '' : 'No gsc_ranking_drops snapshots yet',
    },
    {
      name:     'game-trends-refresh',
      lastRun:  latestTrend ?? null,
      schedule: 'Vercel · 03:00 UTC daily',
      ok:       latestTrend ? (now - new Date(latestTrend).getTime()) < 36 * 60 * 60 * 1000 : false,
      note:     latestTrend ? '' : 'game_trends_cache empty — Odin lacks fresh data',
    },
    {
      name:     'agents-scheduler',
      lastRun:  latestSchedulerRun ?? null,
      schedule: 'GitHub Actions · every 30 min',
      ok:       latestSchedulerRun ? (now - new Date(latestSchedulerRun).getTime()) < 90 * 60 * 1000 : false,
      note:     latestSchedulerRun ? '' : 'No agent_runs in last 24h — scheduler may be silent',
    },
    {
      name:     'weekly-report-generator',
      lastRun:  weeklyReportLatestRes.data?.created_at as string | undefined ?? null,
      schedule: 'GitHub Actions · Monday 01:00 UTC',
      ok:       weeklyReportLatestRes.data ? (now - new Date(weeklyReportLatestRes.data.created_at as string).getTime()) < 8 * 24 * 60 * 60 * 1000 : false,
      note:     weeklyReportLatestRes.data ? '' : 'No weekly reports yet',
    },
    {
      name:     'monthly-report-generator',
      lastRun:  monthlyReportLatestRes.data?.created_at as string | undefined ?? null,
      schedule: 'GitHub Actions · 4th @ 01:00 UTC',
      ok:       monthlyReportLatestRes.data ? (now - new Date(monthlyReportLatestRes.data.created_at as string).getTime()) < 35 * 24 * 60 * 60 * 1000 : false,
      note:     monthlyReportLatestRes.data ? '' : 'No monthly reports yet',
    },
  ]

  // ── 4. Agent activity (last 24h) ──────────────────────────────────────────
  const runs24    = agentRuns24Res.data    ?? []
  const actions24 = agentActions24Res.data ?? []
  const agentKeys = ['heimdall', 'odin', 'loki', 'bragi', 'hermod', 'tyr', 'vor', 'saga']
  const agents24 = agentKeys.map(key => {
    const r = runs24.filter(x => x.agent_key === key)
    return {
      agent_key: key,
      runs:    r.length,
      success: r.filter(x => x.status === 'success').length,
      partial: r.filter(x => x.status === 'partial').length,
      error:   r.filter(x => x.status === 'error').length,
    }
  })
  const agentSummary = {
    totalRuns:    runs24.length,
    totalSuccess: runs24.filter(r => r.status === 'success').length,
    totalPartial: runs24.filter(r => r.status === 'partial').length,
    totalError:   runs24.filter(r => r.status === 'error').length,
    actionsQueued:   actions24.filter(a => a.status === 'pending').length,
    actionsResolved: actions24.filter(a => a.status === 'approved' || a.status === 'rejected' || a.status === 'executed').length,
  }

  // ── 5. Data freshness ────────────────────────────────────────────────────-
  const ageHours = (iso: string | null | undefined): number | null =>
    iso ? Math.round((now - new Date(iso).getTime()) / (1000 * 60 * 60)) : null

  const dataFreshness = [
    { table: 'gsc_ranking_drops', latest: latestDrop ? `${latestDrop}T00:00:00Z` : null, ageHours: ageHours(latestDrop ? `${latestDrop}T00:00:00Z` : null), expectedHours: 36 },
    { table: 'game_trends_cache', latest: latestTrend ?? null,                            ageHours: ageHours(latestTrend),  expectedHours: 36 },
    { table: 'serp_snapshots',    latest: serpSnapshotsLatestRes.data?.snapshot_date ? `${serpSnapshotsLatestRes.data.snapshot_date}T00:00:00Z` : null, ageHours: ageHours(serpSnapshotsLatestRes.data?.snapshot_date ? `${serpSnapshotsLatestRes.data.snapshot_date}T00:00:00Z` : null), expectedHours: 7 * 24 },
    { table: 'seo_content_briefs',latest: briefsLatestRes.data?.updated_at as string | undefined ?? null, ageHours: ageHours(briefsLatestRes.data?.updated_at as string | undefined), expectedHours: 30 * 24 },
  ]

  // ── 6. Recent errors ─────────────────────────────────────────────────────-
  const recentErrors = (recentErrorsRes.data ?? []).map(r => ({
    runId:    r.id as string,
    agent_key: r.agent_key as string,
    status:   r.status as string,
    when:     r.started_at as string,
    summary:  r.summary as string | null,
    error:    r.error_message as string | null,
  }))

  // ── 7. Budget — Claude MTD spend ──────────────────────────────────────────
  const claudeLogs = (claudeUsageMtdRes.data ?? []) as Array<{ metadata: Record<string, unknown> | null; created_at: string }>
  let mtdSpend = 0
  for (const row of claudeLogs) {
    const m = row.metadata ?? {}
    mtdSpend += costForCall(String(m.model ?? 'unknown'), Number(m.input_tokens ?? 0), Number(m.output_tokens ?? 0))
  }

  const budgetUsd = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET_USD ?? '0') || null
  const today    = new Date()
  const daysInMonth     = new Date(today.getUTCFullYear(), today.getUTCMonth() + 1, 0).getUTCDate()
  const dayOfMonth      = today.getUTCDate()
  const projectedSpend  = dayOfMonth > 0 ? (mtdSpend / dayOfMonth) * daysInMonth : 0

  const budget = {
    mtdSpendUsd:          Number(mtdSpend.toFixed(2)),
    projectedSpendUsd:    Number(projectedSpend.toFixed(2)),
    monthlyBudgetUsd:     budgetUsd,
    pctUsed:              budgetUsd ? Number(((mtdSpend / budgetUsd) * 100).toFixed(1)) : null,
    pctProjected:         budgetUsd ? Number(((projectedSpend / budgetUsd) * 100).toFixed(1)) : null,
    daysElapsed:          dayOfMonth,
    daysInMonth,
  }

  // ── 1. Overall roll-up ────────────────────────────────────────────────────
  const issues: Array<{ severity: 'critical' | 'warning'; message: string }> = []

  for (const c of connections) {
    if (!c.ok) {
      // Anthropic + DataForSEO + GSC are critical; Slack + SEMrush + GA4 are warnings
      if (['Anthropic', 'DataForSEO', 'GSC'].includes(c.name)) {
        issues.push({ severity: 'critical', message: `${c.name} connection broken: ${c.detail}` })
      } else {
        issues.push({ severity: 'warning', message: `${c.name}: ${c.detail}` })
      }
    }
  }
  for (const c of crons) {
    if (!c.ok) {
      issues.push({ severity: 'warning', message: `Cron "${c.name}" looks stale or never ran${c.note ? ` (${c.note})` : ''}` })
    }
  }
  if (agentSummary.totalError > 0) {
    issues.push({ severity: 'warning', message: `${agentSummary.totalError} agent run${agentSummary.totalError !== 1 ? 's' : ''} errored in last 24h` })
  }
  if (budget.pctProjected !== null && budget.pctProjected > 100) {
    issues.push({ severity: 'critical', message: `Anthropic spend on track to exceed budget (projected ${budget.pctProjected}% of $${budgetUsd})` })
  } else if (budget.pctProjected !== null && budget.pctProjected > 80) {
    issues.push({ severity: 'warning', message: `Anthropic spend tracking >80% of monthly budget (${budget.pctProjected}%)` })
  }

  const overall = issues.some(i => i.severity === 'critical')
    ? 'critical'
    : issues.length > 0 ? 'warning' : 'ok'

  return NextResponse.json({
    overall,
    issues,
    connections,
    crons,
    agents24,
    agentSummary,
    dataFreshness,
    recentErrors,
    budget,
    checkedAt: new Date().toISOString(),
  })
}
