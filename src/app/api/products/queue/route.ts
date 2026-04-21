import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// GET /api/products/queue?page=1&limit=50&status=generated&q=search
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const url    = new URL(req.url)
  const page   = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'))
  const limit  = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50'))
  const status = url.searchParams.get('status') ?? ''
  const q      = url.searchParams.get('q') ?? ''

  // ── Fetch items ────────────────────────────────────────────────────────────
  let query = db
    .from('product_content_queue')
    .select('*', { count: 'estimated' })
    .eq('owner_user_id', ownerId)
    .order('updated_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)

  if (status) query = query.eq('status', status)
  if (q)      query = query.ilike('product_name', `%${q}%`)

  const { data: items } = await query

  // ── Status counts ──────────────────────────────────────────────────────────
  const { data: rawCounts } = await db
    .from('product_content_queue')
    .select('status')
    .eq('owner_user_id', ownerId)

  const counts: Record<string, number> = { total: 0, pending: 0, generating: 0, generated: 0, uploading: 0, uploaded: 0, failed: 0 }
  for (const row of rawCounts ?? []) {
    counts.total++
    if (row.status in counts) counts[row.status]++
  }

  // ── Last synced ────────────────────────────────────────────────────────────
  const { data: sheetConfig } = await db
    .from('product_sheet_config')
    .select('last_synced_at')
    .eq('owner_user_id', ownerId)
    .single()

  return NextResponse.json({
    items:      items ?? [],
    stats:      counts,
    lastSynced: sheetConfig?.last_synced_at ?? null,
  })
}
