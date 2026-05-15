// Sprint COST.ALERT — Monthly Anthropic API spend aggregator.
//
// Sums cost_usd from api_usage_logs for the calling owner during the
// current calendar month (UTC). We split by provider so the alert message
// can say "of which $X is Anthropic Claude" — that's the spend we actually
// control with the model-tier knob.
//
// Why per-owner: api_usage_logs is owner-scoped via RLS. Each workspace has
// its own ceiling. Galih's G2G + OG both share the same Anthropic API key
// for now, but routing key changes per owner is on the roadmap.

import type { SupabaseClient } from '@supabase/supabase-js'
import { estimateBriefCost } from '@/lib/anthropic/model-tier'

export interface MonthlySpend {
  /** YYYY-MM bucket the spend covers */
  yearMonth:        string
  /** Total spend across all api_name values in the window */
  totalUsd:         number
  /** Spend specifically attributed to Anthropic Claude (api_name='claude') */
  anthropicUsd:     number
  /** Total non-Anthropic spend (DataForSEO + Semrush + Firecrawl + …) */
  nonAnthropicUsd:  number
  /** Per-API breakdown — useful for "where did the money go" reasoning */
  byApi:            Array<{ api: string; usd: number; calls: number }>
  /** Last-recorded log timestamp in the window (debugging "stale data?") */
  latestLogAt:      string | null
}

/**
 * Aggregate api_usage_logs for the current UTC calendar month.
 *
 * @param db        — service-role supabase client (RLS bypassed; we filter ownerId explicitly)
 * @param ownerId   — workspace owner ID
 * @param refTime   — defaults to now(); pass a fixed time to compute historic months
 */
export async function getMonthlySpend(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db:      SupabaseClient<any>,
  ownerId: string,
  refTime: Date = new Date(),
): Promise<MonthlySpend> {
  const year      = refTime.getUTCFullYear()
  const monthIdx  = refTime.getUTCMonth()                                   // 0..11
  const monthStr  = String(monthIdx + 1).padStart(2, '0')
  const yearMonth = `${year}-${monthStr}`

  // First day of the current UTC month at 00:00:00.000Z
  const start = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0)).toISOString()

  // NOTE: api_usage_logs has no cost_usd column. We compute spend on the
  // fly from metadata (model + token counts) using estimateBriefCost().
  // Non-Anthropic rows (DataForSEO etc.) contribute 0 — they're tracked
  // separately and aren't part of the monthly Anthropic ceiling.
  const { data, error } = await db
    .from('api_usage_logs')
    .select('api_name, call_count, metadata, created_at')
    .eq('owner_user_id', ownerId)
    .gte('created_at', start)

  if (error) {
    throw new Error(`getMonthlySpend: ${error.message}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[]

  const byApiMap = new Map<string, { usd: number; calls: number }>()
  let totalUsd       = 0
  let anthropicUsd   = 0
  let latestLogAt: string | null = null

  for (const r of rows) {
    const api  = String(r.api_name ?? 'unknown')
    const cnt  = Number(r.call_count ?? 1)
    let usd = 0
    if (api === 'claude') {
      const md       = (r.metadata ?? {}) as Record<string, unknown>
      const model    = String(md.model ?? 'claude-sonnet-4-6')
      const inTok    = Number(md.input_tokens  ?? 0)
      const outTok   = Number(md.output_tokens ?? 0)
      usd = estimateBriefCost(model, inTok, outTok)
    }
    const cur  = byApiMap.get(api) ?? { usd: 0, calls: 0 }
    cur.usd   += usd
    cur.calls += cnt
    byApiMap.set(api, cur)

    totalUsd += usd
    if (api === 'claude') anthropicUsd += usd

    if (!latestLogAt || r.created_at > latestLogAt) {
      latestLogAt = String(r.created_at)
    }
  }

  const byApi = Array.from(byApiMap.entries())
    .map(([api, v]) => ({ api, usd: Number(v.usd.toFixed(4)), calls: v.calls }))
    .sort((a, b) => b.usd - a.usd)

  return {
    yearMonth,
    totalUsd:        Number(totalUsd.toFixed(2)),
    anthropicUsd:    Number(anthropicUsd.toFixed(2)),
    nonAnthropicUsd: Number((totalUsd - anthropicUsd).toFixed(2)),
    byApi,
    latestLogAt,
  }
}
