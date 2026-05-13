import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST /api/products/auto-content/clear
 *
 * Wipes all rows from product_content_queue for the owner. Used when the
 * user wants a clean restart — typical scenario:
 *   1. Sync hit timeouts, half the rows are stuck in 'generating'
 *   2. User clicks "Clear all" → all DB rows gone
 *   3. User re-imports CSV / re-syncs from sheet → fresh pending rows
 *   4. Auto-process cron picks them up at next 5-minute tick
 *
 * Body (optional):
 *   { only?: 'pending' | 'generating' | 'failed' | 'generated' }
 *     — restrict deletion to a specific status. Default = delete ALL.
 *   { keep_uploaded?: boolean }
 *     — when true, never delete rows that already shipped to CMS. Default true.
 *
 * Returns: { deleted: number, kept: number }
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    only?: 'pending' | 'generating' | 'failed' | 'generated'
    keep_uploaded?: boolean
  }
  const keepUploaded = body.keep_uploaded !== false

  // Count rows that will be deleted vs kept (uploaded protection)
  let countQuery = db
    .from('product_content_queue')
    .select('status', { count: 'exact', head: true })
    .eq('owner_user_id', ownerId)
  if (body.only) countQuery = countQuery.eq('status', body.only)

  const { count: targetCount } = await countQuery

  let deleteQuery = db
    .from('product_content_queue')
    .delete()
    .eq('owner_user_id', ownerId)

  if (body.only) deleteQuery = deleteQuery.eq('status', body.only)
  // Always protect already-uploaded rows unless explicitly opted out — these
  // represent published content. Re-deleting them would orphan the CMS link.
  if (keepUploaded) deleteQuery = deleteQuery.neq('status', 'uploaded')

  const { data: deletedRows, error } = await deleteQuery.select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const deletedCount = deletedRows?.length ?? 0

  // Also clear last_synced_at so the UI's "last sync" header refreshes
  await db
    .from('product_sheet_config')
    .update({ last_synced_at: null, updated_at: new Date().toISOString() })
    .eq('owner_user_id', ownerId)

  return NextResponse.json({
    ok:      true,
    deleted: deletedCount ?? 0,
    target:  targetCount  ?? 0,
    kept:    keepUploaded ? Math.max(0, (targetCount ?? 0) - (deletedCount ?? 0)) : 0,
  })
}
