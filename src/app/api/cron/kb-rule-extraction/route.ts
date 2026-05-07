import { NextResponse } from 'next/server'
import { createClient as createSupabase } from '@supabase/supabase-js'
import { runKbExtraction } from '@/lib/agents/kb-extractor'

export const maxDuration = 120  // Sonnet pass + insert; ample buffer

/**
 * GET /api/cron/kb-rule-extraction
 *
 * Monthly cron — for every active site, runs the winner/loser extractor and
 * writes proposals to kb_rule_proposals. Auth via Bearer CRON_SECRET (called
 * from GitHub Actions or manually for testing).
 *
 * Per-site iteration mirrors the other v2 crons (Task #25 multi-brand pattern).
 * Total time = ~10-30s per site × 2 sites = <1min. Cost ~$0.20 per run.
 */
function isCronAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(req: Request) {
  if (!isCronAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  // Determine which (owner_user_id, site_slug) pairs to process. We pull
  // every active site_configs row paired with the unique owners that have
  // EVER published a brief on that site — that's the universe that has
  // ranking outcomes worth analyzing.
  const { data: sites } = await db
    .from('site_configs')
    .select('slug')
    .eq('is_active', true)

  if (!sites || sites.length === 0) {
    return NextResponse.json({ error: 'No active sites' }, { status: 500 })
  }

  const results: Array<{ site: string; ownerId: string; ok: boolean; stats?: unknown; error?: string }> = []

  for (const site of sites) {
    const { data: owners } = await db
      .from('seo_content_briefs')
      .select('owner_user_id')
      .eq('site_slug', site.slug)
      .eq('status', 'published')
      .limit(1000)

    const uniqueOwners = Array.from(new Set((owners ?? []).map(o => String(o.owner_user_id))))
    for (const ownerId of uniqueOwners) {
      try {
        const stats = await runKbExtraction({ db, ownerId, siteSlug: String(site.slug) })
        results.push({ site: String(site.slug), ownerId, ok: true, stats })
      } catch (err) {
        results.push({
          site: String(site.slug),
          ownerId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return NextResponse.json({
    ok:    results.every(r => r.ok),
    runs:  results,
    when:  new Date().toISOString(),
  })
}
