import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

const VALID_SCOPES     = ['global', 'site', 'topic', 'product'] as const
const VALID_CATEGORIES = ['preference', 'fact', 'rule', 'lesson'] as const
const VALID_SOURCES    = ['manual', 'extracted', 'imported'] as const

// ─── GET /api/mimir/memories ────────────────────────────────────────────────
// Sprint MIMIR.POLISH.2 — accept tier / product_tier_id / source_kind /
// importance_min / cross_only query params so the admin UI can mirror them
// in URL (shareable links like `?tier=1&product=abc123`).
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const scope        = searchParams.get('scope')    ?? ''
  const category     = searchParams.get('category') ?? ''
  const source       = searchParams.get('source')   ?? ''
  const tierParam    = searchParams.get('tier')     ?? ''     // '1' | '2' | 'untagged' | ''
  const productId    = (searchParams.get('product') ?? '').trim()
  const importMin    = parseInt(searchParams.get('importance_min') ?? '0', 10)
  const crossOnly    = searchParams.get('cross_only') === '1'
  const q            = (searchParams.get('q') ?? '').trim()
  const includeArchived = searchParams.get('include_archived') === '1'
  const onlyActiveSite  = searchParams.get('site_filter') === '1'

  let query = db
    .from('mimir_memories')
    .select('*')
    .eq('owner_user_id', ownerId)
    .order('pinned', { ascending: false })
    .order('importance', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(500)

  if (!includeArchived)  query = query.eq('archived', false)
  if (VALID_SCOPES.includes(scope as typeof VALID_SCOPES[number]))         query = query.eq('scope', scope)
  if (VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) query = query.eq('category', category)
  if (VALID_SOURCES.includes(source as typeof VALID_SOURCES[number]))       query = query.eq('source_kind', source)
  if (tierParam === '1')        query = query.eq('tier', 1)
  if (tierParam === '2')        query = query.eq('tier', 2)
  if (tierParam === 'untagged') query = query.is('tier', null)
  if (productId)                query = query.eq('product_tier_id', productId)
  if (importMin > 0)            query = query.gte('importance', importMin)
  if (crossOnly)                query = query.eq('apply_to_category', true)
  if (onlyActiveSite)   query = query.or(`scope.eq.global,site_slug.eq.${siteSlug},and(site_slug.is.null,scope.neq.site)`)
  if (q) {
    const safe = q.replace(/[%,()]/g, ' ')
    query = query.ilike('content', `%${safe}%`)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ memories: data ?? [] })
}

// ─── POST /api/mimir/memories — manual add ─────────────────────────────────
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  const body = await req.json().catch(() => ({})) as {
    content?:         string
    category?:        string
    scope?:           string
    site_slug?:       string
    topic_slug?:      string
    relation_id?:     string
    tags?:            string[]
    importance?:      number
    pinned?:          boolean
    expires_at?:      string | null
    // Sprint MIMIR.NOTES.INLINE — when supplied, server auto-resolves tier
    // context from the brief's primary_keyword and binds the memory accordingly.
    brief_id?:        string
    // Direct tier context (set by SignalModal endpoint that already resolved it).
    tier?:            number | null
    product_tier_id?: string | null
    // Sprint MIMIR.NOTES.APPLY — category-wide pattern propagation. When true,
    // memory applies to ALL products in the same category (not just THIS product).
    // Used for cross-product learning that propagates T1/T2 manual work to T0 later.
    apply_to_category?: boolean
    product_category?:  string   // optional override; usually auto-resolved
  }

  const content = String(body.content ?? '').trim().slice(0, 280)
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  const scope    = VALID_SCOPES.includes(body.scope as typeof VALID_SCOPES[number])         ? body.scope    : 'global'
  const category = VALID_CATEGORIES.includes(body.category as typeof VALID_CATEGORIES[number]) ? body.category : 'fact'

  // Sprint MIMIR.NOTES.INLINE — if a brief_id is passed, resolve tier context.
  // Sprint MIMIR.NOTES.APPLY — also resolve product category for category
  // pattern propagation. Stored even when apply_to_category=false so the
  // retriever can later promote memories from product-only → category-wide
  // without needing a join.
  let resolvedTier:          number | null = typeof body.tier === 'number'   ? body.tier            : null
  let resolvedProductTierId: string | null = typeof body.product_tier_id === 'string' ? body.product_tier_id : null
  let resolvedRelationId:    string | null = body.relation_id ?? null
  let resolvedCategory:      string | null = body.product_category ?? null
  if (body.brief_id) {
    const { data: brief } = await db
      .from('seo_content_briefs')
      .select('primary_keyword, site_slug, page')
      .eq('id', body.brief_id)
      .maybeSingle()
    if (brief?.primary_keyword || brief?.page) {
      // Match against product_tiers by name or url
      const { data: tierRow } = await db
        .from('product_tiers')
        .select('id, tier, relation_id, product_name, url, category')
        .eq('owner_user_id', ownerId)
        .eq('site_slug', brief.site_slug ?? siteSlug)
        .or(`product_name.ilike.${String(brief.primary_keyword ?? '').replace(/[,()]/g, ' ')},url.eq.${brief.page ?? ''}`)
        .limit(1)
        .maybeSingle()
      if (tierRow) {
        resolvedTier          = tierRow.tier as number
        resolvedProductTierId = tierRow.id   as string
        if (!resolvedRelationId) resolvedRelationId = (tierRow.relation_id as string | null) ?? null
        if (!resolvedCategory)   resolvedCategory   = (tierRow.category as string | null) ?? null
      }
    }
  }
  // If category still null but product_tier_id known (from signal endpoint), look it up
  if (!resolvedCategory && resolvedProductTierId) {
    const { data: prod } = await db
      .from('product_tiers')
      .select('category')
      .eq('id', resolvedProductTierId)
      .maybeSingle()
    if (prod?.category) resolvedCategory = String(prod.category)
  }

  const { data, error } = await db
    .from('mimir_memories')
    .insert({
      owner_user_id:   ownerId,
      content,
      scope,
      category,
      site_slug:   scope === 'site' || scope === 'topic' || scope === 'product' ? (body.site_slug ?? siteSlug) : null,
      topic_slug:  scope === 'topic'   ? body.topic_slug  ?? null : null,
      relation_id: scope === 'product' ? resolvedRelationId    : null,
      tier:            resolvedTier,
      product_tier_id: resolvedProductTierId,
      product_category:   resolvedCategory,
      apply_to_category:  !!body.apply_to_category,
      tags:        Array.isArray(body.tags) ? body.tags.map(t => String(t).toLowerCase()).slice(0, 6) : [],
      importance:  typeof body.importance === 'number' ? Math.max(0, Math.min(100, body.importance)) : 70,
      pinned:      !!body.pinned,
      expires_at:  body.expires_at ?? null,
      source_kind: 'manual',
    })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ memory: data })
}

// ─── PATCH /api/mimir/memories?id= ─────────────────────────────────────────
// Body: subset of fields to update.
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({})) as Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = { updated_at: new Date().toISOString() }
  if (typeof body.content === 'string')    patch.content    = String(body.content).slice(0, 280)
  if (typeof body.pinned  === 'boolean')   patch.pinned     = body.pinned
  if (typeof body.archived === 'boolean')  patch.archived   = body.archived
  if (typeof body.importance === 'number') patch.importance = Math.max(0, Math.min(100, body.importance))
  if (VALID_CATEGORIES.includes(body.category as typeof VALID_CATEGORIES[number])) patch.category = body.category
  if (Array.isArray(body.tags))            patch.tags = body.tags.map(t => String(t).toLowerCase()).slice(0, 6)

  const { data, error } = await db
    .from('mimir_memories')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ memory: data })
}

// ─── DELETE /api/mimir/memories?id= ────────────────────────────────────────
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await db
    .from('mimir_memories')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
