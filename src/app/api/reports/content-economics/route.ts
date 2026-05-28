import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 30

/**
 * GET /api/reports/content-economics?days=30
 *
 * Two answers in one payload:
 *   1. LEAD TIME — how long does each step in the content lifecycle take?
 *      (created → generated → uploaded)
 *   2. COST — what does each article cost to produce vs the manual baseline?
 *
 * Designed for the management answer to: "AI agent populates content in
 * ~10 min — track and report."
 */

interface QueueRow {
  id:                  string
  created_at:          string
  generated_at:        string | null
  cms_uploaded_at:     string | null
  status:              string
  cms_upload_status:   string | null
}

function percentile(arr: number[], p: number): number | null {
  if (arr.length === 0) return null
  const sorted = arr.slice().sort((a, b) => a - b)
  const idx = Math.floor((p / 100) * (sorted.length - 1))
  return sorted[idx]
}

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const days = Math.min(180, Math.max(1, parseInt(searchParams.get('days') ?? '30', 10)))
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()

  // 1. Fetch product_content_queue rows in window
  const { data: rows } = await db
    .from('product_content_queue')
    .select('id, created_at, generated_at, cms_uploaded_at, status, cms_upload_status')
    .eq('owner_user_id', ownerId)
    .gte('created_at', sinceIso)
  const queue = (rows ?? []) as QueueRow[]

  // 2. Lead-time deltas (in seconds)
  const createdToGenerated: number[] = []
  const generatedToUploaded: number[] = []
  const createdToUploaded:   number[] = []
  for (const r of queue) {
    if (r.generated_at && r.created_at) {
      const dt = (new Date(r.generated_at).getTime() - new Date(r.created_at).getTime()) / 1000
      if (dt >= 0 && dt < 86400) createdToGenerated.push(dt)   // <24h sanity bound
    }
    if (r.cms_uploaded_at && r.generated_at) {
      const dt = (new Date(r.cms_uploaded_at).getTime() - new Date(r.generated_at).getTime()) / 1000
      if (dt >= 0 && dt < 86400) generatedToUploaded.push(dt)
    }
    if (r.cms_uploaded_at && r.created_at) {
      const dt = (new Date(r.cms_uploaded_at).getTime() - new Date(r.created_at).getTime()) / 1000
      if (dt >= 0 && dt < 86400) createdToUploaded.push(dt)
    }
  }

  const stats = {
    total_rows:         queue.length,
    generated:          queue.filter(r => r.status === 'generated' || r.status === 'uploaded').length,
    uploaded:           queue.filter(r => r.cms_upload_status === 'uploaded').length,
    awaiting_token:     queue.filter(r => r.cms_upload_status === 'awaiting_token').length,
    failed:             queue.filter(r => r.status === 'failed' || r.cms_upload_status === 'failed').length,
    pending:            queue.filter(r => r.status === 'pending').length,
    lead_time_seconds: {
      created_to_generated: {
        avg: avg(createdToGenerated),
        p50: percentile(createdToGenerated, 50),
        p95: percentile(createdToGenerated, 95),
        n:   createdToGenerated.length,
      },
      generated_to_uploaded: {
        avg: avg(generatedToUploaded),
        p50: percentile(generatedToUploaded, 50),
        p95: percentile(generatedToUploaded, 95),
        n:   generatedToUploaded.length,
      },
      created_to_uploaded: {
        avg: avg(createdToUploaded),
        p50: percentile(createdToUploaded, 50),
        p95: percentile(createdToUploaded, 95),
        n:   createdToUploaded.length,
      },
    },
  }

  // 3. Cost from api_usage_logs
  const { data: costs } = await db
    .from('api_usage_logs')
    .select('api_name, endpoint, call_count, cost_usd, created_at')
    .gte('created_at', sinceIso)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const costRows = (costs ?? []) as any[]

  const byApi: Record<string, { calls: number; cost: number }> = {}
  for (const c of costRows) {
    const name = String(c.api_name ?? 'unknown')
    const cur = byApi[name] ?? { calls: 0, cost: 0 }
    cur.calls += Number(c.call_count ?? 1)
    cur.cost  += Number(c.cost_usd ?? 0)
    byApi[name] = cur
  }
  const totalCost  = Object.values(byApi).reduce((s, v) => s + v.cost, 0)
  const totalCalls = Object.values(byApi).reduce((s, v) => s + v.calls, 0)
  const costPerArticle = stats.generated > 0 ? totalCost / stats.generated : 0

  // Manual baseline: ~1h × $20/hr = $20/article + 15min CMS upload × $15/hr = $3.75
  const MANUAL_COST_PER_ARTICLE = 23.75
  const manualBaseline = stats.generated * MANUAL_COST_PER_ARTICLE
  const savings = manualBaseline - totalCost

  return NextResponse.json({
    window_days: days,
    queue_stats: stats,
    cost: {
      by_api:           Object.entries(byApi).map(([api, v]) => ({ api, calls: v.calls, cost_usd: Number(v.cost.toFixed(4)) })),
      total_cost_usd:   Number(totalCost.toFixed(2)),
      total_api_calls:  totalCalls,
      cost_per_article: Number(costPerArticle.toFixed(4)),
      manual_baseline_per_article: MANUAL_COST_PER_ARTICLE,
      manual_baseline_total:       Number(manualBaseline.toFixed(2)),
      savings_total:               Number(savings.toFixed(2)),
      savings_pct:                 manualBaseline > 0 ? Math.round((savings / manualBaseline) * 100) : 0,
    },
  })
}

function avg(arr: number[]): number | null {
  if (arr.length === 0) return null
  return Number((arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(1))
}
