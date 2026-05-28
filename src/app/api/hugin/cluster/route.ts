import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { clusterQueries, type ClusterInput } from '@/lib/hugin/cluster'

export const maxDuration = 60

/**
 * POST /api/hugin/cluster
 *
 * Sprint HUGIN.API — group selected long-tail queries into semantic clusters
 * via Haiku. UI calls this with { query_ids: string[] } — server loads the
 * hugin_queries rows, then sends to clusterQueries() which returns groups
 * by (brand × sub_product).
 *
 * Cost: ~$0.003 per 30-query batch (Haiku). Galih can cluster 100 queries
 * per call for ~$0.01.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const body = await req.json().catch(() => ({})) as { query_ids?: string[] }
  const ids = Array.isArray(body.query_ids) ? body.query_ids.filter(s => typeof s === 'string') : []
  if (ids.length === 0) {
    return NextResponse.json({ error: 'query_ids required' }, { status: 400 })
  }
  if (ids.length > 100) {
    return NextResponse.json({ error: 'Max 100 queries per cluster request' }, { status: 400 })
  }

  // Load rows scoped to caller's owner — verify ownership + get text/imp
  const { data: rows, error } = await db
    .from('hugin_queries')
    .select('id, query, total_impressions, auto_matched_product_name')
    .eq('owner_user_id', ownerId)
    .in('id', ids)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: 'No matching queries found' }, { status: 404 })
  }

  const inputs: ClusterInput[] = rows.map(r => ({
    query:                     r.query as string,
    total_impressions:         Number(r.total_impressions) || 0,
    auto_matched_product_name: r.auto_matched_product_name as string | null,
  }))

  const result = await clusterQueries(db, ownerId, inputs)
  return NextResponse.json(result)
}
