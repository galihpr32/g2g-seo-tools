import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'

export const maxDuration = 15

const VALID_SCOPES     = ['global', 'site', 'topic', 'product'] as const
const VALID_CATEGORIES = ['preference', 'fact', 'rule', 'lesson'] as const

// ─── GET /api/mimir/memories?scope=&category=&q=&include_archived=0 ────────
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
    content?:     string
    category?:    string
    scope?:       string
    site_slug?:   string
    topic_slug?:  string
    relation_id?: string
    tags?:        string[]
    importance?:  number
    pinned?:      boolean
    expires_at?:  string | null
  }

  const content = String(body.content ?? '').trim().slice(0, 280)
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 })

  const scope    = VALID_SCOPES.includes(body.scope as typeof VALID_SCOPES[number])         ? body.scope    : 'global'
  const category = VALID_CATEGORIES.includes(body.category as typeof VALID_CATEGORIES[number]) ? body.category : 'fact'

  const { data, error } = await db
    .from('mimir_memories')
    .insert({
      owner_user_id: ownerId,
      content,
      scope,
      category,
      site_slug:   scope === 'site' || scope === 'topic' || scope === 'product' ? (body.site_slug ?? siteSlug) : null,
      topic_slug:  scope === 'topic'   ? body.topic_slug  ?? null : null,
      relation_id: scope === 'product' ? body.relation_id ?? null : null,
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
