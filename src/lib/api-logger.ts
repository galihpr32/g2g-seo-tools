// ─── API Usage Logger ─────────────────────────────────────────────────────────
// Fire-and-forget helper. Call from route handlers WITHOUT awaiting.
// Inserts one row into api_usage_logs per API call made.
//
// Usage:
//   logApiUsage(supabase, ownerId, { api: 'dataforseo', endpoint: 'serp/organic',
//     triggeredBy: 'backlink_refresh', callCount: backlinks.length })

import type { SupabaseClient } from '@supabase/supabase-js'

export type ApiName       = 'dataforseo' | 'semrush' | 'firecrawl' | 'claude'
export type TriggerSource =
  | 'brief_generate'
  | 'brief_draft'
  | 'url_analysis'
  | 'backlink_refresh'
  | 'backlink_check'
  | 'keyword_load'
  | 'agent_heimdall'
  | 'agent_loki'
  | 'agent_odin'
  | 'agent_bragi'
  | 'agent_hermod'
  | 'agent_tyr'
  | 'agent_vor'
  | 'agent_saga'
  | 'other'

export interface LogApiUsageParams {
  api:         ApiName
  endpoint:    string
  triggeredBy: TriggerSource
  callCount?:  number
  metadata?:   Record<string, unknown>
}

export function logApiUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:    SupabaseClient<any>,
  ownerId:     string,
  params:      LogApiUsageParams,
): void {
  // Intentionally not awaited — fire and forget
  void supabase
    .from('api_usage_logs')
    .insert({
      owner_user_id: ownerId,
      api_name:      params.api,
      endpoint:      params.endpoint,
      call_count:    params.callCount ?? 1,
      triggered_by:  params.triggeredBy,
      metadata:      params.metadata ?? {},
    })
    .then(() => {/* silent */}, (err: unknown) => console.error('[api-logger] insert error:', err))
}

// ── Convenience wrapper for Anthropic calls ─────────────────────────────────-
// Captures token counts in metadata so api-costs page can compute spend.
//
// Usage:
//   const res = await anthropic.messages.create({ model, ... })
//   logClaudeUsage(supabase, ownerId, {
//     model, endpoint: 'review_brief', triggeredBy: 'agent_tyr', usage: res.usage,
//   })
//
// The `usage` arg accepts Anthropic's full response.usage shape OR a manual
// { input_tokens, output_tokens } object.
interface ClaudeUsage {
  input_tokens?:                number | null
  output_tokens?:               number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?:     number | null
}

export interface LogClaudeUsageParams {
  model:       string
  endpoint:    string             // descriptive label, e.g. 'review_brief', 'classify_keywords'
  triggeredBy: TriggerSource
  usage?:      ClaudeUsage
  extra?:      Record<string, unknown>
}

export function logClaudeUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  ownerId:  string,
  params:   LogClaudeUsageParams,
): void {
  const u = params.usage ?? {}
  logApiUsage(supabase, ownerId, {
    api:         'claude',
    endpoint:    params.endpoint,
    triggeredBy: params.triggeredBy,
    callCount:   1,
    metadata: {
      model:                       params.model,
      input_tokens:                u.input_tokens                ?? 0,
      output_tokens:               u.output_tokens               ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:     u.cache_read_input_tokens     ?? 0,
      ...(params.extra ?? {}),
    },
  })
}
