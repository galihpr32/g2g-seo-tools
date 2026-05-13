import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { findMatches } from '@/lib/g2g/fuzzy-match'

export const maxDuration = 90

/**
 * POST /api/admin/opportunities/match-products
 * Body (all optional):
 *   {
 *     force?:     boolean   // re-match opportunities that already have matched_at set
 *     threshold?: number    // default 0.55
 *     limit?:     number    // cap total opps processed in one call (default 1000)
 *   }
 *
 * Walks unmatched seo_opportunities, fuzzy-matches each topic against the
 * canonical g2g_products catalog, and persists matched_relation_id +
 * match_score + matched_at. Stamps matched_at even on no-match so the next
 * run skips them unless `force=true`.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as { force?: boolean; threshold?: number; limit?: number }
  const force     = !!body.force
  const threshold = typeof body.threshold === 'number' ? body.threshold : 0.55
  const limit     = Math.min(5000, Math.max(1, body.limit ?? 1000))

  // ── 1. Load catalog (active only) — fits in memory comfortably ─────────
  const { data: catalog, error: catErr } = await db
    .from('g2g_products')
    .select('relation_id, brand_name')
    .eq('is_active', true)
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 })

  if (!catalog || catalog.length === 0) {
    return NextResponse.json({ error: 'Catalog is empty — import a CSV at /settings/g2g-products first.' }, { status: 400 })
  }

  // ── 2. Load opportunities that need matching ──────────────────────────
  let oppQuery = db
    .from('seo_opportunities')
    .select('id, topic')
    .eq('owner_user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (!force) oppQuery = oppQuery.is('matched_at', null)

  const { data: opps, error: oppErr } = await oppQuery
  if (oppErr) return NextResponse.json({ error: oppErr.message }, { status: 500 })

  if (!opps || opps.length === 0) {
    return NextResponse.json({ processed: 0, matched: 0, unmatched: 0, message: 'Nothing to match.' })
  }

  // ── 3. Match each opportunity ────────────────────────────────────────
  let matched = 0
  let unmatched = 0
  const now = new Date().toISOString()

  for (const opp of opps) {
    const candidates = findMatches(String(opp.topic ?? ''), catalog, threshold, 1)
    const best = candidates[0]

    const patch = best
      ? { matched_relation_id: best.relation_id, match_score: Number(best.score.toFixed(2)), matched_at: now, updated_at: now }
      : { matched_relation_id: null, match_score: null, matched_at: now, updated_at: now }

    const { error: upErr } = await db
      .from('seo_opportunities')
      .update(patch)
      .eq('id', opp.id)

    if (upErr) {
      console.warn(`[opp-match] failed to update ${opp.id}: ${upErr.message}`)
      continue
    }
    if (best) matched++; else unmatched++;
  }

  return NextResponse.json({
    processed:        opps.length,
    matched,
    unmatched,
    catalog_size:     catalog.length,
    threshold,
  })
}
