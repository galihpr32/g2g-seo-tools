import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { runKbExtraction } from '@/lib/agents/kb-extractor'

export const maxDuration = 120

/**
 * POST /api/knowledge-base/proposals/extract
 *
 * Manual trigger for the KB rule extractor. Useful for:
 *   - Testing during development without waiting for the monthly cron
 *   - Force-running after a major content batch ships
 *   - Re-running for the active site after rejecting/applying prior proposals
 *
 * Returns the same stats shape as the cron run.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const body     = await req.json().catch(() => ({}))
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db       = createServiceClient()

  try {
    const stats = await runKbExtraction({ db, ownerId, siteSlug })
    return NextResponse.json({ ok: true, ...stats, siteSlug })
  } catch (err) {
    return NextResponse.json({
      ok:    false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}
