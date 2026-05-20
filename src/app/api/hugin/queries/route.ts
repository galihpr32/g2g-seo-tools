import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 30

/**
 * GET /api/hugin/queries
 *
 * Sprint HUGIN.API — list endpoint with filters + tab views.
 *
 * Query params:
 *   period=7|30|60|90              (default 30)
 *   tab=growing|new|climbing|ctr_rising|all|claimed|covered|ignored
 *   min_words=N                     (default 4)
 *   min_impressions=N               (default 30)
 *   exclude_brand=1                 (default true — brand queries filtered at aggregator anyway)
 *   q=<search text>
 *   limit=N                         (default 200, max 1000)
 *
 * Returns:
 *   { rows: HuginRow[], counts: { ... per tab ... } }
 */

const VALID_TABS = ['growing', 'new', 'climbing', 'ctr_rising', 'all', 'claimed', 'covered', 'ignored'] as const
type Tab = (typeof VALID_TABS)[number]

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db       = createServiceClient()

  const { searchParams } = new URL(req.url)
  const period   = parseInt(searchParams.get('period') ?? '30', 10) || 30
  const tabRaw   = (searchParams.get('tab') ?? 'growing').toLowerCase()
  const tab: Tab = (VALID_TABS as readonly string[]).includes(tabRaw) ? (tabRaw as Tab) : 'growing'
  const minWords = parseInt(searchParams.get('min_words') ?? '4', 10) || 4
  const minImp   = parseInt(searchParams.get('min_impressions') ?? '30', 10) || 30
  const q        = (searchParams.get('q') ?? '').trim()
  const limit    = Math.min(1000, parseInt(searchParams.get('limit') ?? '200', 10) || 200)

  let query = db
    .from('hugin_queries')
    .select('*')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .eq('period_days',   period)
    .gte('word_count',   minWords)
    .gte('total_impressions', minImp)
    .limit(limit)

  // Tab-specific filters + ordering
  if (tab === 'growing') {
    query = query
      .eq('status', 'discovered')
      .not('growth_pct', 'is', null)
      .gte('growth_pct', 20)
      .order('growth_pct', { ascending: false })
  } else if (tab === 'new') {
    query = query
      .eq('status', 'discovered')
      .eq('is_new',  true)
      .order('total_impressions', { ascending: false })
  } else if (tab === 'climbing') {
    query = query
      .eq('status', 'discovered')
      .not('position_delta', 'is', null)
      .gte('position_delta', 1)   // moved up at least 1 position
      .order('position_delta', { ascending: false })
  } else if (tab === 'ctr_rising') {
    // Heuristic: ctr_current > ctr_prior AND prior had some signal
    query = query
      .eq('status', 'discovered')
      .not('ctr_current', 'is', null)
      .not('ctr_prior',   'is', null)
      .order('ctr_current', { ascending: false })
  } else if (tab === 'claimed') {
    query = query.eq('status', 'claimed').order('claimed_at', { ascending: false })
  } else if (tab === 'covered') {
    query = query.eq('status', 'covered').order('updated_at', { ascending: false })
  } else if (tab === 'ignored') {
    query = query.eq('status', 'ignored').order('updated_at', { ascending: false })
  } else {
    // all
    query = query.order('total_impressions', { ascending: false })
  }

  if (q) {
    const safe = q.replace(/[%,()]/g, ' ')
    query = query.ilike('query', `%${safe.toLowerCase()}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Post-filter for ctr_rising (Postgres comparison between two columns is awkward via PostgREST)
  let rows = data ?? []
  if (tab === 'ctr_rising') {
    rows = rows.filter(r => Number(r.ctr_current) > Number(r.ctr_prior))
  }

  // Compute per-tab counts (same filters minus tab-specific) for header badges
  const { data: countRows } = await db
    .from('hugin_queries')
    .select('status, growth_pct, is_new, position_delta, ctr_current, ctr_prior')
    .eq('owner_user_id', ownerId)
    .eq('site_slug',     siteSlug)
    .eq('period_days',   period)
    .gte('word_count',   minWords)
    .gte('total_impressions', minImp)
    .limit(5000)

  const counts = { growing: 0, new: 0, climbing: 0, ctr_rising: 0, all: 0, claimed: 0, covered: 0, ignored: 0 }
  for (const r of countRows ?? []) {
    counts.all++
    const s = r.status as string
    if (s === 'claimed') counts.claimed++
    if (s === 'covered') counts.covered++
    if (s === 'ignored') counts.ignored++
    if (s === 'discovered') {
      if (typeof r.growth_pct === 'number' && r.growth_pct >= 20) counts.growing++
      if (r.is_new)                                                counts.new++
      if (typeof r.position_delta === 'number' && r.position_delta >= 1) counts.climbing++
      if (typeof r.ctr_current === 'number' && typeof r.ctr_prior === 'number' && r.ctr_current > r.ctr_prior) counts.ctr_rising++
    }
  }

  return NextResponse.json({ rows, counts })
}

// ─── PATCH — status changes + claim → tier_keywords ────────────────────────
//
// Body: {
//   status?:   'claimed' | 'covered' | 'ignored' | 'discovered'
//   claimed_to_product_id?: string    // required when status='claimed'
//   status_note?: string
// }
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db      = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as {
    status?:                  string
    claimed_to_product_id?:   string
    status_note?:             string
  }

  const validStatuses = ['discovered', 'claimed', 'covered', 'ignored']
  if (body.status && !validStatuses.includes(body.status)) {
    return NextResponse.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, { status: 400 })
  }

  // Load existing row to verify ownership + get query text
  const { data: existing, error: loadErr } = await db
    .from('hugin_queries')
    .select('id, query, site_slug, period_days, auto_matched_product_id')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!existing) return NextResponse.json({ error: 'Hugin query not found' }, { status: 404 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (body.status) {
    patch.status = body.status
    if (body.status === 'claimed') {
      const productId = body.claimed_to_product_id ?? existing.auto_matched_product_id
      if (!productId) {
        return NextResponse.json({ error: 'claimed_to_product_id required (no auto-match available)' }, { status: 400 })
      }
      patch.claimed_to_product_id = productId
      patch.claimed_at             = new Date().toISOString()
      patch.claimed_by_user_id     = user.id

      // Sprint HUGIN.API — also insert into tier_keywords so the query starts
      // getting tracked by the normal keyword-rankings cron. Skip silently if
      // already exists for this product (don't fail the PATCH).
      try {
        await db.from('tier_keywords').insert({
          owner_user_id:   ownerId,
          product_tier_id: productId,
          keyword:         existing.query,
          language:        'en',                 // default; user can edit in keyword admin
        }).select('id')
      } catch (err) {
        console.warn(`[hugin] tier_keywords insert non-fatal:`, err instanceof Error ? err.message : String(err))
      }
    }
  }
  if (typeof body.status_note === 'string') patch.status_note = body.status_note.slice(0, 500)

  const { data: updated, error } = await db
    .from('hugin_queries')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ row: updated })
}
