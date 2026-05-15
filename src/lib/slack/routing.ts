// ─── Slack webhook routing ──────────────────────────────────────────────────
// Resolve which webhook URL to use for a given notification_type. Falls
// back through three levels:
//
//   1. slack_routing_config row matching (owner, site, type) — most specific
//   2. slack_routing_config row matching (owner, site=null, type) — site-agnostic
//   3. env var SLACK_WEBHOOK_URL — global default (preserves existing behaviour)
//
// Returns null if every level fails (so callers can short-circuit cleanly).

import type { SupabaseClient } from '@supabase/supabase-js'

export type NotificationType =
  | 'agent_performance'
  | 'tier_summary'
  | 'weekly_report'
  | 'daily_alerts'
  | 'cms_alerts'
  | 'bug_reports'
  | 'general'
  | 'friday_kpi'   // Sprint FRIDAY.KPI — combined G2G + OG digest, Friday 15:00 WIB

interface ResolveOpts {
  /** When omitted, only site-agnostic + env fallback are tried. */
  siteSlug?: string | null
}

/**
 * Resolve the webhook URL for a given notification. Designed to be cheap
 * (≤ 1 DB call per resolution; result not cached across requests).
 *
 * @param db        — service-role supabase client
 * @param ownerId   — workspace owner ID
 * @param type      — notification category
 * @param opts.siteSlug — optional brand scope
 */
export async function resolveSlackWebhook(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  type:    NotificationType,
  opts:    ResolveOpts = {},
): Promise<string | null> {
  try {
    // Pull both candidates in one query — server filters happen client-side
    // since we need (site_slug == X) OR (site_slug IS NULL) with priority
    // on the specific match.
    const { data } = await db
      .from('slack_routing_config')
      .select('site_slug, webhook_url, enabled')
      .eq('owner_user_id', ownerId)
      .eq('notification_type', type)
      .eq('enabled', true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[]

    if (opts.siteSlug) {
      const specific = rows.find(r => r.site_slug === opts.siteSlug)
      if (specific?.webhook_url) return String(specific.webhook_url)
    }
    const agnostic = rows.find(r => r.site_slug === null)
    if (agnostic?.webhook_url) return String(agnostic.webhook_url)
  } catch {
    // DB error → fall through to env fallback (preserve existing behaviour)
  }

  return process.env.SLACK_WEBHOOK_URL ?? null
}

/**
 * Convenience: POST a Slack message to the routed webhook for a given
 * notification type. Returns the response status, or null when no webhook
 * was resolvable (caller can decide to log/skip).
 */
export async function postSlackRouted(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any, any, any>,
  ownerId: string,
  type:    NotificationType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  opts:    ResolveOpts = {},
): Promise<{ ok: boolean; status: number; routed_to: 'config' | 'env' | 'none' } | null> {
  const url = await resolveSlackWebhook(db, ownerId, type, opts)
  if (!url) return { ok: false, status: 0, routed_to: 'none' }

  const routedTo = url === process.env.SLACK_WEBHOOK_URL ? 'env' : 'config'

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    return { ok: res.ok, status: res.status, routed_to: routedTo }
  } catch {
    return { ok: false, status: 0, routed_to: routedTo }
  }
}
