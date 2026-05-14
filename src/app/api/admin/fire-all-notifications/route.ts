import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const maxDuration = 300

// ─── Force-fire all Slack notification crons ────────────────────────────────
// Sprint MULTI.6 — manual smoke test for the multi-channel routing config.
// POST with optional { types: CronKey[] } body → fires the cron routes in
// parallel via internal fetch (Bearer CRON_SECRET) and returns a per-channel
// outcome report so Galih can verify routing without waiting for the next
// scheduled run.
//
// NOTE: cms_alerts + bug_reports are event-driven (JWT expiry, in-app feedback)
// — they're not fireable from here. For those, use the per-row test ping at
// /settings/slack-routing instead.

type CronKey =
  | 'tier_rank_alerts'
  | 'tier_weekly_summary'
  | 'weekly_report'
  | 'agent_performance'
  | 'tech_escalation'
  | 'gsc_daily'

interface CronDef {
  key:               CronKey
  label:             string
  notification_type: string
  path:              string
  description:       string
}

const CRONS: CronDef[] = [
  { key: 'tier_rank_alerts',    label: 'Tier ranking alerts',          notification_type: 'daily_alerts',      path: '/api/cron/tier-rank-alerts',         description: 'T1 drops ≥3 / T2 out of top-10' },
  { key: 'tier_weekly_summary', label: 'Tier weekly summary',          notification_type: 'tier_summary',      path: '/api/cron/tier-weekly-summary',      description: 'Positive scorecard across all tier kws' },
  { key: 'weekly_report',       label: 'Weekly performance report',    notification_type: 'weekly_report',     path: '/api/cron/weekly-report-generator',  description: 'GSC + GA4 + PPTX (slow: ~15-30s/brand)' },
  { key: 'agent_performance',   label: 'Agent performance digest',     notification_type: 'agent_performance', path: '/api/cron/agent-performance-weekly', description: 'AI agent activity + cost vs savings' },
  { key: 'tech_escalation',     label: 'Tech-debt escalation',         notification_type: 'daily_alerts',      path: '/api/cron/tech-escalation',          description: 'Stale tech action items >14d' },
  { key: 'gsc_daily',           label: 'GSC daily (clicks/CWV/index)', notification_type: 'daily_alerts',      path: '/api/cron/gsc-daily',                description: 'Drops / CWV / index — alerts only on real moves' },
]

interface FireResult {
  key:               CronKey
  label:             string
  notification_type: string
  http_status:       number | null
  latency_ms:        number
  outcome:           'slack_fired' | 'skipped_no_data' | 'no_webhook' | 'slack_post_failed' | 'cron_error' | 'partial'
  per_target?:       Array<{ target: string; outcome: string; note?: string }>
  raw_response:      unknown
  error_reason:      string | null
  suggestion:        string | null
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({})) as { types?: CronKey[] }
  const validKeys = new Set(CRONS.map(c => c.key))
  const selected = body.types && body.types.length > 0
    ? CRONS.filter(c => body.types!.includes(c.key) && validKeys.has(c.key))
    : CRONS

  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 })
  }

  // Use the request origin so we work in any env (no NEXT_PUBLIC_APP_URL dep).
  const origin = new URL(req.url).origin

  const started = Date.now()
  const results = await Promise.all(selected.map(c => fireCron(origin, c)))
  const totalDuration = Date.now() - started

  const summary = {
    total:              results.length,
    fired:              results.filter(r => r.outcome === 'slack_fired').length,
    partial:            results.filter(r => r.outcome === 'partial').length,
    skipped_no_data:    results.filter(r => r.outcome === 'skipped_no_data').length,
    no_webhook:         results.filter(r => r.outcome === 'no_webhook').length,
    slack_post_failed:  results.filter(r => r.outcome === 'slack_post_failed').length,
    cron_error:         results.filter(r => r.outcome === 'cron_error').length,
    total_duration_ms:  totalDuration,
  }

  return NextResponse.json({ summary, results })
}

// GET — return the list of fireable crons (for the UI to render checkboxes)
export async function GET() {
  return NextResponse.json({ crons: CRONS })
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function fireCron(origin: string, cron: CronDef): Promise<FireResult> {
  const start = Date.now()
  try {
    const res = await fetch(`${origin}${cron.path}`, {
      method:  'GET',
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      // Disable Next caching for cron self-calls
      cache:   'no-store',
    })
    const latency_ms = Date.now() - start
    const text = await res.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* keep raw text */ }

    if (!res.ok) {
      return {
        key:               cron.key,
        label:             cron.label,
        notification_type: cron.notification_type,
        http_status:       res.status,
        latency_ms,
        outcome:           'cron_error',
        raw_response:      json ?? text.slice(0, 500),
        error_reason:      (json as { error?: string })?.error ?? `HTTP ${res.status}`,
        suggestion:        'Check Vercel function logs for the cron route stack trace',
      }
    }
    return interpretOutcome(cron, res.status, latency_ms, json)
  } catch (e) {
    return {
      key:               cron.key,
      label:             cron.label,
      notification_type: cron.notification_type,
      http_status:       null,
      latency_ms:        Date.now() - start,
      outcome:           'cron_error',
      raw_response:      null,
      error_reason:      e instanceof Error ? e.message : String(e),
      suggestion:        'Self-fetch failed — usually a 5xx from the cron route or function timeout',
    }
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function interpretOutcome(cron: CronDef, status: number, latency: number, json: any): FireResult {
  const base = {
    key:               cron.key,
    label:             cron.label,
    notification_type: cron.notification_type,
    http_status:       status,
    latency_ms:        latency,
    raw_response:      json,
  }

  // Helpers — each cron has a slightly different response shape; we read the
  // message strings + structured flags it emits.
  const msg = String(json?.message ?? '')

  switch (cron.key) {
    case 'tier_rank_alerts': {
      if (json?.delivered === 'slack' && (json?.alerts ?? 0) > 0) {
        return { ...base, outcome: 'slack_fired', error_reason: null, suggestion: null }
      }
      if (msg.includes('No alert-worthy')) {
        return { ...base, outcome: 'skipped_no_data',
          error_reason: 'No T1 drops ≥3 or T2 fall-outs found in last snapshot diff',
          suggestion:   'Either (a) wait for next SERP refresh, or (b) seed a deliberate ranking drop to verify',
        }
      }
      if (msg.includes('No recent snapshots')) {
        return { ...base, outcome: 'skipped_no_data',
          error_reason: 'No tier_serp_snapshots in last 21 days',
          suggestion:   'Run /api/cron/tier-serp-weekly first to seed snapshots',
        }
      }
      if (msg.includes('No Slack webhook')) {
        return { ...base, outcome: 'no_webhook',
          error_reason: 'Neither slack_routing_config (daily_alerts) nor SLACK_WEBHOOK_URL env resolved',
          suggestion:   'Configure a daily_alerts route in /settings/slack-routing',
        }
      }
      return { ...base, outcome: 'partial', error_reason: msg || 'Unrecognised response shape', suggestion: null }
    }

    case 'tier_weekly_summary': {
      if (json?.delivered === 'slack' && (json?.brands?.length ?? 0) > 0) {
        return { ...base, outcome: 'slack_fired', error_reason: null, suggestion: null }
      }
      if (msg.includes('No SERP snapshots') || msg.includes('No tier products')) {
        return { ...base, outcome: 'skipped_no_data',
          error_reason: msg,
          suggestion:   msg.includes('tier products')
            ? 'Add Tier 1/2 products at /settings/product-tiers'
            : 'Run tier-serp-weekly first to seed snapshots',
        }
      }
      if (msg.includes('No Slack webhook')) {
        return { ...base, outcome: 'no_webhook',
          error_reason: 'No tier_summary webhook resolved',
          suggestion:   'Configure tier_summary route in /settings/slack-routing',
        }
      }
      return { ...base, outcome: 'partial', error_reason: msg || 'Unrecognised response shape', suggestion: null }
    }

    case 'weekly_report': {
      // Response shape: { triggered, delivered, owners, sites, results: { [ownerId]: { [siteSlug]: {...} } } }
      const perTarget: FireResult['per_target'] = []
      let firedCount  = 0
      let totalCount  = 0
      let webhookMissCount = 0
      if (json?.results) {
        for (const ownerId of Object.keys(json.results)) {
          for (const siteSlug of Object.keys(json.results[ownerId])) {
            totalCount++
            const r = json.results[ownerId][siteSlug] as { ok?: boolean; slack_posted?: boolean; notes?: string[]; error?: string; reportId?: string }
            const target = siteSlug
            if (r.slack_posted) {
              perTarget.push({ target, outcome: 'fired', note: r.reportId ? `report ${String(r.reportId).slice(0, 8)}` : undefined })
              firedCount++
            } else if (r.notes?.some(n => n.includes('No Slack webhook'))) {
              perTarget.push({ target, outcome: 'no_webhook', note: 'no webhook resolved' })
              webhookMissCount++
            } else if (r.ok === false) {
              perTarget.push({ target, outcome: 'error', note: r.error ?? r.notes?.join('; ') ?? 'unknown' })
            } else {
              perTarget.push({ target, outcome: 'partial', note: (r.notes ?? []).join('; ') })
            }
          }
        }
      }
      if (firedCount === totalCount && totalCount > 0) {
        return { ...base, outcome: 'slack_fired', per_target: perTarget, error_reason: null, suggestion: null }
      }
      if (totalCount === 0) {
        return { ...base, outcome: 'skipped_no_data', per_target: perTarget,
          error_reason: 'No owners with active sites found',
          suggestion:   'Connect GSC at /settings → make sure site_configs has at least one is_active row',
        }
      }
      if (webhookMissCount === totalCount) {
        return { ...base, outcome: 'no_webhook', per_target: perTarget,
          error_reason: 'No weekly_report webhook resolved for any brand',
          suggestion:   'Configure weekly_report routes per brand in /settings/slack-routing',
        }
      }
      if (firedCount > 0) {
        return { ...base, outcome: 'partial', per_target: perTarget,
          error_reason: `${firedCount}/${totalCount} brand(s) delivered to Slack`,
          suggestion:   'Inspect per_target rows for the non-fired brands',
        }
      }
      return { ...base, outcome: 'cron_error', per_target: perTarget,
        error_reason: 'No brand delivered to Slack',
        suggestion:   'Inspect per_target — common causes: PPTX build failed or Drive upload failed',
      }
    }

    case 'agent_performance': {
      const posted = json?.posted ?? 0
      const errors = (json?.errors ?? []) as string[]
      if (posted > 0 && errors.length === 0) {
        return { ...base, outcome: 'slack_fired', error_reason: null, suggestion: null }
      }
      if (posted > 0 && errors.length > 0) {
        return { ...base, outcome: 'partial',
          error_reason: `${posted} fired, ${errors.length} errors: ${errors.slice(0, 2).join(' | ')}`,
          suggestion:   'Check errors[] for per-brand failure reasons',
        }
      }
      if (posted === 0 && errors.length === 0) {
        return { ...base, outcome: 'skipped_no_data',
          error_reason: 'No brands had agent activity in last 7 days (briefs / content / API calls all zero)',
          suggestion:   'Generate a brief or run any agent first to seed activity, then re-fire',
        }
      }
      if (errors.some(e => e.includes('no webhook'))) {
        return { ...base, outcome: 'no_webhook',
          error_reason: errors.join('; '),
          suggestion:   'Configure agent_performance route in /settings/slack-routing',
        }
      }
      return { ...base, outcome: 'cron_error', error_reason: errors.join('; ') || 'Unknown failure', suggestion: null }
    }

    case 'tech_escalation': {
      if (msg.includes('No stale')) {
        return { ...base, outcome: 'skipped_no_data',
          error_reason: 'No tech action items aged >14 days',
          suggestion:   'Wait for items to age, or temporarily lower the threshold to verify routing',
        }
      }
      if (msg.includes('No Slack webhook')) {
        return { ...base, outcome: 'no_webhook',
          error_reason: 'No daily_alerts webhook resolved',
          suggestion:   'Configure daily_alerts route in /settings/slack-routing',
        }
      }
      if (json?.ok && json?.slack_status === 200) {
        return { ...base, outcome: 'slack_fired', error_reason: null, suggestion: null }
      }
      if (json?.ok === false) {
        return { ...base, outcome: 'slack_post_failed',
          error_reason: msg || `Slack HTTP ${json?.slack_status}`,
          suggestion:   'Webhook URL likely invalid — re-create incoming webhook in Slack admin',
        }
      }
      return { ...base, outcome: 'partial', error_reason: msg || 'Unrecognised response', suggestion: null }
    }

    case 'gsc_daily': {
      // Sprint FORCE-FIRE.FIX — slack_posted_count is now in the cron response
      const slackPosted = Number(json?.slack_posted_count ?? 0)
      const results = (json?.results ?? {}) as Record<string, { status?: string; drops?: number; error?: string }>
      const errors: string[] = []
      let totalDrops         = 0
      const perTarget: FireResult['per_target'] = []
      for (const k of Object.keys(results)) {
        const r = results[k]
        if (r.status === 'error') {
          errors.push(`${k}: ${r.error ?? 'unknown'}`)
          perTarget.push({ target: k, outcome: 'error', note: r.error ?? 'unknown' })
        } else {
          totalDrops += r.drops ?? 0
          perTarget.push({ target: k, outcome: r.drops && r.drops > 0 ? 'drops_detected' : 'no_drops', note: `${r.drops ?? 0} drops` })
        }
      }
      if (errors.length > 0 && totalDrops === 0 && slackPosted === 0) {
        return { ...base, outcome: 'cron_error', per_target: perTarget,
          error_reason: errors.join(' | '),
          suggestion:   'Check GSC OAuth tokens / GA4 property ID',
        }
      }
      // Honest delivery check: only claim slack_fired if cron actually posted
      if (slackPosted > 0) {
        return { ...base, outcome: 'slack_fired', per_target: perTarget,
          error_reason: null,
          suggestion:   `${slackPosted} Slack message(s) posted (clicks/index/CWV combined)`,
        }
      }
      if (totalDrops > 0) {
        return { ...base, outcome: 'partial', per_target: perTarget,
          error_reason: `${totalDrops} drops detected but 0 Slack messages posted`,
          suggestion:   'Check (a) toggles at /settings → Slack Notification Settings — clicks/CWV default OFF · (b) URL filter: only /categories/ pages alert',
        }
      }
      return { ...base, outcome: 'skipped_no_data', per_target: perTarget,
        error_reason: 'No drops >15% WoW detected (or none on /categories/ alertable pages)',
        suggestion:   'Routing itself is fine. Slack fires only when there are real drops on alertable pages.',
      }
    }
  }
}
