import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { costForCall } from '@/lib/anthropic-pricing'

export const maxDuration = 30

/**
 * GET /api/costs/balance
 * Live API balance/spend snapshot.
 *
 * - DataForSEO: live balance via /v3/appendix/user_data
 * - SEMrush: api_units endpoint (gracefully degraded for plans that don't expose it)
 * - Anthropic: no live balance API exists — we compute month-to-date spend
 *   from `api_usage_logs` token counts × pricing table
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const [dfsBalance, semrushBalance, anthropicSpend] = await Promise.all([
    fetchDataForSeoBalance(),
    fetchSemrushBalance(),
    computeAnthropicSpend(db, ownerId),
  ])

  return NextResponse.json({
    dataforseo: dfsBalance,
    semrush:    semrushBalance,
    anthropic:  anthropicSpend,
    checked_at: new Date().toISOString(),
  })
}

// ── DataForSEO: GET /v3/appendix/user_data ──────────────────────────────────-
// Real response shape (Apr 2026):
//   tasks[0].result[0] = {
//     money: { balance: 100.5, total: 200, ... },
//     rates: { ... }, queues: { ... }, limits: { ... }
//   }
// Note: this endpoint does NOT include per-day/all-time call counts —
// those are tracked in our own api_usage_logs.
async function fetchDataForSeoBalance(): Promise<{
  money_balance: number | null
  api_calls_today: number | null
  api_calls_total: number | null
  error?: string
}> {
  const login = process.env.DATAFORSEO_LOGIN ?? ''
  const pass  = process.env.DATAFORSEO_PASSWORD ?? ''

  if (!login || !pass) {
    return { money_balance: null, api_calls_today: null, api_calls_total: null,
      error: 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set in Vercel env' }
  }

  try {
    const auth = 'Basic ' + Buffer.from(`${login}:${pass}`).toString('base64')
    const res  = await fetch('https://api.dataforseo.com/v3/appendix/user_data', {
      headers: { Authorization: auth },
      signal:  AbortSignal.timeout(10000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { money_balance: null, api_calls_today: null, api_calls_total: null,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 100)}` : ''}` }
    }

    const json = await res.json() as {
      tasks?: Array<{
        result?: Array<{
          money?: { balance?: number; total?: number; spent?: number }
        }>
      }>
    }
    const result = json?.tasks?.[0]?.result?.[0]
    if (!result) {
      return { money_balance: null, api_calls_today: null, api_calls_total: null,
        error: 'Unexpected response shape from DataForSEO user_data endpoint' }
    }

    return {
      money_balance:   result.money?.balance ?? null,
      api_calls_today: null,    // not exposed by this endpoint; see /api/costs/usage
      api_calls_total: null,
    }
  } catch (err) {
    return { money_balance: null, api_calls_today: null, api_calls_total: null,
      error: err instanceof Error ? err.message : String(err) }
  }
}

// ── SEMrush: GET ?type=api_units ────────────────────────────────────────────-
// Some plans (Guru and below) don't expose api_units. Detect and degrade
// gracefully instead of surfacing a raw HTTP 400 to the user.
async function fetchSemrushBalance(): Promise<{
  units_remaining: number | null
  plan_supports_balance: boolean
  error?: string
}> {
  const key = process.env.SEMRUSH_API_KEY ?? ''
  if (!key) {
    return { units_remaining: null, plan_supports_balance: false,
      error: 'SEMRUSH_API_KEY not set' }
  }
  if (key === 'placeholder' || key.length < 10) {
    return { units_remaining: null, plan_supports_balance: false,
      error: 'SEMRUSH_API_KEY is a placeholder — add real key in Vercel env' }
  }

  try {
    const url = `https://api.semrush.com/?type=api_units&key=${encodeURIComponent(key)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })

    // SEMrush plans Pro/Guru do NOT support api_units endpoint and return
    // 400 with body "ERROR :: NOTHING FOUND" or "query type not found".
    // Treat that as plan limitation, not a failure.
    if (res.status === 400) {
      const body = (await res.text().catch(() => '')).toLowerCase()
      if (body.includes('query type not found') ||
          body.includes('nothing found') ||
          body.includes('error')) {
        return { units_remaining: null, plan_supports_balance: false,
          error: 'Your SEMrush plan (Guru / Pro) does not expose api_units. Upgrade to Business to track balance, or check usage in SEMrush dashboard directly.' }
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { units_remaining: null, plan_supports_balance: false,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 100)}` : ''}` }
    }

    const text = (await res.text()).trim()
    const units = parseInt(text, 10)
    if (isNaN(units)) {
      return { units_remaining: null, plan_supports_balance: false,
        error: text.slice(0, 120) }
    }

    return { units_remaining: units, plan_supports_balance: true }
  } catch (err) {
    return { units_remaining: null, plan_supports_balance: false,
      error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Anthropic: month-to-date spend from `api_usage_logs` ────────────────────-
async function computeAnthropicSpend(
  db: ReturnType<typeof createServiceClient>,
  ownerId: string,
): Promise<{
  month_to_date_usd: number
  total_calls_mtd:   number
  total_input_tokens:  number
  total_output_tokens: number
  by_model: Array<{ model: string; calls: number; cost_usd: number; input_tokens: number; output_tokens: number }>
  by_endpoint: Array<{ endpoint: string; calls: number; cost_usd: number }>
  error?: string
}> {
  // Month-to-date window: 1st of current month → now
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

  const { data, error } = await db
    .from('api_usage_logs')
    .select('endpoint, call_count, metadata, created_at')
    .eq('owner_user_id', ownerId)
    .eq('api_name', 'claude')
    .gte('created_at', monthStart)

  if (error) {
    return {
      month_to_date_usd: 0, total_calls_mtd: 0,
      total_input_tokens: 0, total_output_tokens: 0,
      by_model: [], by_endpoint: [],
      error: error.message,
    }
  }

  const logs = (data ?? []) as Array<{
    endpoint: string | null
    call_count: number
    metadata: Record<string, unknown> | null
  }>

  let totalCost = 0
  let totalIn   = 0
  let totalOut  = 0
  const byModel    = new Map<string, { calls: number; cost: number; input: number; output: number }>()
  const byEndpoint = new Map<string, { calls: number; cost: number }>()

  for (const row of logs) {
    const meta = row.metadata ?? {}
    const model = String(meta.model ?? 'unknown')
    const inT   = Number(meta.input_tokens  ?? 0)
    const outT  = Number(meta.output_tokens ?? 0)
    const cost  = costForCall(model, inT, outT)
    const calls = row.call_count ?? 1

    totalCost += cost
    totalIn   += inT
    totalOut  += outT

    const m = byModel.get(model) ?? { calls: 0, cost: 0, input: 0, output: 0 }
    m.calls  += calls
    m.cost   += cost
    m.input  += inT
    m.output += outT
    byModel.set(model, m)

    const ep = row.endpoint ?? 'unknown'
    const e  = byEndpoint.get(ep) ?? { calls: 0, cost: 0 }
    e.calls += calls
    e.cost  += cost
    byEndpoint.set(ep, e)
  }

  return {
    month_to_date_usd:  Number(totalCost.toFixed(4)),
    total_calls_mtd:    logs.length,
    total_input_tokens:  totalIn,
    total_output_tokens: totalOut,
    by_model:    Array.from(byModel.entries())
                   .map(([model, v]) => ({ model, calls: v.calls, cost_usd: Number(v.cost.toFixed(4)), input_tokens: v.input, output_tokens: v.output }))
                   .sort((a, b) => b.cost_usd - a.cost_usd),
    by_endpoint: Array.from(byEndpoint.entries())
                   .map(([endpoint, v]) => ({ endpoint, calls: v.calls, cost_usd: Number(v.cost.toFixed(4)) }))
                   .sort((a, b) => b.cost_usd - a.cost_usd),
  }
}
