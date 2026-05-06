import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

export const maxDuration = 15

/**
 * GET /api/products/auto-content/imports
 *
 * Returns the audit history of CSV/sheet imports for the workspace.
 * Powers the "Import History" section on the Product Content page.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { data, error } = await db
    .from('product_content_imports')
    .select('id, source, source_file, imported_at, rows_total, rows_new, rows_updated, rows_skipped, rows_conflicts, notes')
    .eq('owner_user_id', ownerId)
    .order('imported_at', { ascending: false })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ imports: data ?? [] })
}
