import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

// ── GET /api/costs/usage?months=3 ─────────────────────────────────────────────
// Returns aggregated API usage from api_usage_logs for the last N months.
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const months = Math.min(parseInt(searchParams.get('months') ?? '3', 10), 12)

  const since = new Date()
  since.setMonth(since.getMonth() - months)

  const { data: logs, error } = await supabase
    .from('api_usage_logs')
    .select('api_name, endpoint, call_count, triggered_by, created_at')
    .eq('owner_user_id', ownerId)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // ── Aggregate by month × api ──────────────────────────────────────────────
  type MonthlyRow = { month: string; api: string; calls: number }
  const monthlyMap = new Map<string, number>()

  for (const log of logs ?? []) {
    const month = log.created_at.slice(0, 7) // "2026-04"
    const key   = `${month}__${log.api_name}`
    monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + (log.call_count ?? 1))
  }

  const monthly: MonthlyRow[] = Array.from(monthlyMap.entries()).map(([key, calls]) => {
    const [month, api] = key.split('__')
    return { month, api, calls }
  }).sort((a, b) => b.month.localeCompare(a.month))

  // ── Aggregate by trigger source ───────────────────────────────────────────
  const byTrigger = new Map<string, number>()
  for (const log of logs ?? []) {
    const t = log.triggered_by ?? 'other'
    byTrigger.set(t, (byTrigger.get(t) ?? 0) + (log.call_count ?? 1))
  }

  const byTriggerArr = Array.from(byTrigger.entries())
    .map(([trigger, calls]) => ({ trigger, calls }))
    .sort((a, b) => b.calls - a.calls)

  // ── Total per API ──────────────────────────────────────────────────────────
  const totals = new Map<string, number>()
  for (const log of logs ?? []) {
    totals.set(log.api_name, (totals.get(log.api_name) ?? 0) + (log.call_count ?? 1))
  }

  const totalsByApi = Array.from(totals.entries())
    .map(([api, calls]) => ({ api, calls }))
    .sort((a, b) => b.calls - a.calls)

  // ── Recent rows (last 50) ──────────────────────────────────────────────────
  const recent = (logs ?? []).slice(0, 50).map(l => ({
    api:          l.api_name,
    endpoint:     l.endpoint,
    call_count:   l.call_count,
    triggered_by: l.triggered_by,
    created_at:   l.created_at,
  }))

  return NextResponse.json({
    period_months: months,
    since:         since.toISOString(),
    monthly,
    by_trigger:    byTriggerArr,
    totals_by_api: totalsByApi,
    recent,
    total_calls:   (logs ?? []).reduce((s, l) => s + (l.call_count ?? 1), 0),
  })
}
