import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * GET    /api/clusters/[id]   — full cluster detail (keywords + pages + children)
 * PATCH  /api/clusters/[id]   — update topic / description / parent_map_id / status
 * DELETE /api/clusters/[id]   — cascade delete (FK ON DELETE CASCADE handles
 *                               keyword_map_clusters + cluster_pages + sub maps)
 *
 * GET response shape:
 *   {
 *     cluster: { id, topic, level, parent_map_id, ... },
 *     parent:  { id, topic } | null,
 *     children: [{ id, topic, keyword_count, page_count }],   // only when level=0
 *     keywords: [{ id, keyword, search_volume, source, ... }], // only when level=1
 *     pages:    [{ id, page_url, role, notes }]
 *   }
 */

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const { data: cluster, error } = await db
    .from('keyword_maps')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!cluster) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [parentRes, childrenRes, keywordsRes, pagesRes] = await Promise.all([
    cluster.parent_map_id
      ? db.from('keyword_maps').select('id, topic, topic_slug, level').eq('id', cluster.parent_map_id).maybeSingle()
      : Promise.resolve({ data: null }),
    cluster.level === 0
      ? db.from('keyword_maps')
          .select('id, topic, topic_slug, source, auto_generated, status')
          .eq('parent_map_id', cluster.id)
          .order('topic')
      : Promise.resolve({ data: [] }),
    cluster.level === 1
      ? db.from('keyword_map_clusters')
          .select('*')
          .eq('map_id', cluster.id)
          .order('priority_order', { ascending: true })
      : Promise.resolve({ data: [] }),
    db.from('cluster_pages').select('*').eq('cluster_id', cluster.id).order('created_at'),
  ])

  // Decorate child nodes with keyword + page counts (only when this is a brand)
  let children: Array<Record<string, unknown>> = childrenRes.data ?? []
  if (cluster.level === 0 && children.length > 0) {
    const subIds = children.map(c => c.id as string)
    const [{ data: kwCounts }, { data: pgCounts }] = await Promise.all([
      db.from('keyword_map_clusters').select('map_id').in('map_id', subIds),
      db.from('cluster_pages').select('cluster_id').in('cluster_id', subIds),
    ])
    const kwBy = new Map<string, number>()
    const pgBy = new Map<string, number>()
    for (const r of (kwCounts ?? []) as { map_id: string }[]) kwBy.set(r.map_id, (kwBy.get(r.map_id) ?? 0) + 1)
    for (const r of (pgCounts ?? []) as { cluster_id: string }[]) pgBy.set(r.cluster_id, (pgBy.get(r.cluster_id) ?? 0) + 1)
    children = children.map(c => ({
      ...c,
      keyword_count: kwBy.get(c.id as string) ?? 0,
      page_count:    pgBy.get(c.id as string) ?? 0,
    }))
  }

  return NextResponse.json({
    cluster,
    parent:   parentRes.data ?? null,
    children,
    keywords: keywordsRes.data ?? [],
    pages:    pagesRes.data ?? [],
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  // Whitelist mutable fields. parent_map_id changes are accepted (move a
  // sub-product under a different brand) but require validation that the
  // new parent is level=0 and same owner+site.
  const patch: Record<string, unknown> = {}
  for (const k of ['topic', 'topic_slug', 'description', 'status', 'parent_map_id'] as const) {
    if (k in body) patch[k] = body[k]
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no editable fields supplied' }, { status: 400 })
  }

  // Sprint CLUSTER.RENAME.3 — if topic changes but no slug supplied, compute it
  if ('topic' in patch && typeof patch.topic === 'string' && !('topic_slug' in patch)) {
    const t = patch.topic.trim()
    if (!t) return NextResponse.json({ error: 'topic cannot be empty' }, { status: 400 })
    patch.topic_slug = t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
  }

  const db = createServiceClient()

  // Ownership check first (so we don't leak existence of others' rows)
  const { data: existing } = await db
    .from('keyword_maps')
    .select('id, owner_user_id, site_slug, level, topic, topic_original')
    .eq('id', id)
    .maybeSingle()
  if (!existing || existing.owner_user_id !== ownerId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Sprint CLUSTER.RENAME.3 — first time topic is renamed, capture the original
  // value so user can restore. Subsequent renames don't clobber the backup.
  if ('topic' in patch && typeof patch.topic === 'string' && patch.topic !== existing.topic && !existing.topic_original) {
    patch.topic_original = existing.topic
  }

  if ('parent_map_id' in patch && patch.parent_map_id) {
    const { data: parent } = await db
      .from('keyword_maps')
      .select('id, owner_user_id, site_slug, level')
      .eq('id', String(patch.parent_map_id))
      .maybeSingle()
    if (!parent || parent.owner_user_id !== ownerId || parent.site_slug !== existing.site_slug) {
      return NextResponse.json({ error: 'invalid parent_map_id' }, { status: 400 })
    }
    if (parent.level !== 0) {
      return NextResponse.json({ error: 'parent must be level-0 brand cluster' }, { status: 400 })
    }
  }

  patch.updated_at = new Date().toISOString()

  const { data, error } = await db
    .from('keyword_maps')
    .update(patch)
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ cluster: data })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  // Cascade FK on parent_map_id + keyword_map_clusters + cluster_pages handles children/keywords/pages.
  const { error } = await db
    .from('keyword_maps')
    .delete()
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
