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
