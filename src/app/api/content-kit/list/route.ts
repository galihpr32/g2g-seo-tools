import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Sprint CKB.3 — List Content Kits for the calling owner.
 *
 * GET /api/content-kit/list?product_id=<uuid>&status=<status>&limit=<n>
 *   product_id   optional, filter to one product
 *   status       optional, filter by status (default: exclude 'superseded')
 *   limit        default 50, max 200
 *
 * Returns a slim list (no kit_data) for index views. Full kit fetched via
 * /api/content-kit/:id.
 */
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()
  const url     = new URL(req.url)
  const productId = url.searchParams.get('product_id')
  const status    = url.searchParams.get('status')
  const limit     = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200)

  let query = db
    .from('content_kits')
    .select(`
      id, product_tier_id, primary_keyword_id, primary_keyword,
      market, language, status, error_message,
      build_started_at, build_completed_at, sent_to_bragi_at,
      created_at, updated_at
    `)
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (productId) query = query.eq('product_tier_id', productId)
  if (status)    query = query.eq('status', status)
  else           query = query.neq('status', 'superseded')

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, kits: data ?? [] })
}
