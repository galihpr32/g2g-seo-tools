import { NextResponse } from 'next/server'
import { createClient as createSupabase, type SupabaseClient } from '@supabase/supabase-js'
import { getMonthlySpend, type MonthlySpend } from '@/lib/costs/monthly-spend'
import { resolveSlackWebhook } from '@/lib/slack/routing'

export const maxDuration = 60

/**
 * GET /api/cron/cost-alert
 *
 * Sprint COST.ALERT — Daily check of month-to-date Anthropic API spend.
 * Fires Slack when:
 *   • warning  ≥ COST_ALERT_WARNING_USD  (default $28)
 *   • critical ≥ COST_ALERT_CRITICAL_USD (default $35)
 *
 * Idempotency: cost_alert_state records (owner × yearMonth × level) per
 * fire so the same threshold pings exactly ONCE per calendar month, even
 * though this cron runs daily. New month auto-resets because yearMonth
 * changes; no manual cleanup needed.
 *
 * Why these defaults: model-tier rollout (Sprint BRAGI.MODEL.TIER) projects
 * ~$0.13/article. At ~200 articles/month that's $26. $28 = "we're heading
 * past plan", $35 = "stop the bus".
 *
 * Runs for every distinct owner_user_id present in api_usage_logs this
 * month — multi-tenant safe.
 *
 * Schedule: daily 06:00 UTC = 13:00 WIB (see .github/workflows/cost-alert-daily.yml).
 *
 * Auth: Bearer CRON_SECRET.
 */
function isCronAuth(req: Request): boolean {
  return req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

const WARNING_USD  = Number(process.env.COST_ALERT_WARNING_USD  ?? '28')
const CRITICAL_USD = Number(process.env.COST_ALERT_CRITICAL_USD ?? '35')

type Level = 'warning' | 'critical'

interface FireResult {
  ownerId:     string
  yearMonth:   string
  spend:       MonthlySpend
  fired:       Level[]
  skipped:     Array<{ level: Level; reason: string }>
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // 1. Find every owner with cost-bearing API activity this month.
  //    Cheaper than scanning every workspace; only those with spend can
  //    trip a threshold.
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const { data: ownerRows, error: ownerErr } = await db
    .from('api_usage_logs')
    .select('owner_user_id')
    .gte('created_at', monthStart.toISOString())
    .not('owner_user_id', 'is', null)
  if (ownerErr) {
    return NextResponse.json({ error: `owner scan: ${ownerErr.message}` }, { status: 500 })
  }
  const owners = Array.from(new Set(
    (ownerRows ?? []).map(r => String(r.owner_user_id)),
  )).filter(Boolean)

  const results: FireResult[] = []

  for (const ownerId of owners) {
    // eslint-disable-next-line no-await-in-loop
    const spend = await getMonthlySpend(db, ownerId)
    const result: FireResult = {
      ownerId, yearMonth: spend.yearMonth, spend, fired: [], skipped: [],
    }

    // Anthropic-only ceiling (matches BRAGI cost projections).
    const subjectUsd = spend.anthropicUsd
    const levelsToCheck: Array<{ level: Level; threshold: number }> = []
    if (subjectUsd >= CRITICAL_USD) levelsToCheck.push({ level: 'critical', threshold: CRITICAL_USD })
    if (subjectUsd >= WARNING_USD)  levelsToCheck.push({ level: 'warning',  threshold: WARNING_USD  })

    for (const { level, threshold } of levelsToCheck) {
      // eslint-disable-next-line no-await-in-loop
      const skipReason = await tryFire(db, ownerId, spend, level, threshold)
      if (skipReason) result.skipped.push({ level, reason: skipReason })
      else            result.fired.push(level)
    }

    results.push(result)
  }

  return NextResponse.json({
    ok:        true,
    timestamp: new Date().toISOString(),
    thresholds: { warning_usd: WARNING_USD, critical_usd: CRITICAL_USD },
    owners_scanned: owners.length,
    results,
  })
}

/**
 * Attempt to fire one (owner × month × level) alert. Returns a skip reason
 * string when no alert was sent, or null when the Slack fire succeeded
 * (state row inserted, threshold pinged).
 */
async function tryFire(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:        SupabaseClient<any>,
  ownerId:   string,
  spend:     MonthlySpend,
  level:     Level,
  threshold: number,
): Promise<string | null> {
  // Idempotency check — has this (owner × month × level) already fired?
  const { data: existing } = await db
    .from('cost_alert_state')
    .select('id')
    .eq('owner_user_id', ownerId)
    .eq('year_month',    spend.yearMonth)
    .eq('level',         level)
    .limit(1)
    .maybeSingle()
  if (existing?.id) return 'already_fired_this_month'

  // Resolve webhook — daily_alerts is the closest existing notification_type
  // for budget pings. (We could split this out later.)
  const url = await resolveSlackWebhook(db, ownerId, 'daily_alerts')
  if (!url) return 'no_webhook'

  const payload = buildSlackPayload(spend, level, threshold)
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(() => null)
  if (!res || !res.ok) return `slack_post_failed_${res?.status ?? 'network'}`

  const { error: stateErr } = await db
    .from('cost_alert_state')
    .insert({
      owner_user_id: ownerId,
      year_month:    spend.yearMonth,
      level,
      spend_usd:     spend.anthropicUsd,
    })
  if (stateErr) return `state_insert_failed:${stateErr.message}`

  return null
}

function buildSlackPayload(spend: MonthlySpend, level: Level, threshold: number) {
  const isCritical = level === 'critical'
  const emoji      = isCritical ? '🛑' : '⚠️'
  const headline   = isCritical
    ? `${emoji} CRITICAL: Anthropic spend hit $${threshold}`
    : `${emoji} Warning: Anthropic spend crossed $${threshold}`

  const projection = spend.anthropicUsd > 0
    ? ` (projected end-of-month: $${projectMonthEnd(spend.anthropicUsd).toFixed(0)})`
    : ''

  const breakdown = spend.byApi
    .filter(a => a.usd > 0)
    .slice(0, 6)
    .map(a => `• \`${a.api}\` — $${a.usd.toFixed(2)} (${a.calls} calls)`)
    .join('\n')

  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: headline, emoji: true } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `*Month:* ${spend.yearMonth}`,
            `*Anthropic month-to-date:* *$${spend.anthropicUsd.toFixed(2)}*${projection}`,
            `*All-API total:* $${spend.totalUsd.toFixed(2)}`,
            isCritical
              ? '*Action:* Consider pausing autopublish and switching T1 to Sonnet temporarily.'
              : '*Heads up:* Spend is heading past the $30 plan. Watch model-tier mix.',
          ].join('\n'),
        },
      },
      ...(breakdown ? [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*Per-API breakdown:*\n${breakdown}` },
      }] : []),
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Threshold: $${threshold} · One ping per month per level · Latest log: ${spend.latestLogAt ?? 'n/a'}`,
        }],
      },
    ],
  }
}

/**
 * Linear projection: extrapolate current month-to-date spend to a full month
 * based on how many UTC days have elapsed. Crude but useful for the alert
 * message — gives Galih a "where will we land" number to react to.
 */
function projectMonthEnd(currentUsd: number, now: Date = new Date()): number {
  const year       = now.getUTCFullYear()
  const monthIdx   = now.getUTCMonth()
  const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
  const dayOfMonth = now.getUTCDate()
  if (dayOfMonth <= 0) return currentUsd
  return (currentUsd / dayOfMonth) * daysInMonth
}
