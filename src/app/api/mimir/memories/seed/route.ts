import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { seedMimirMemories } from '@/lib/agents/mimir-memory-seed'

export const maxDuration = 60

/**
 * POST /api/mimir/memories/seed
 * Scans tier products, knowledge base, brief outcomes, campaigns for the
 * active owner × site and seeds Mimir memory with them.
 *
 * Idempotent — re-runs skip memories that already exist by content match.
 * Returns per-source counts so the UI can show what landed.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const result = await seedMimirMemories(db, ownerId, siteSlug)
  return NextResponse.json({ ok: result.errors.length === 0, ...result })
}
