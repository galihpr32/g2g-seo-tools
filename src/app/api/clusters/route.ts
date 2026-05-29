import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'
import { resolveSiteSlugFromRequest } from '@/lib/sites'
import { slugify } from '@/lib/agents/site-helpers'

/**
 * GET /api/clusters?site=<slug>
 *
 * Returns the brand→sub-product hierarchy for the active site. Output is
 * tree-shaped — each brand carries `children` (its sub-products) and each
 * sub-product carries `keyword_count` + `page_count`. Lightweight; no
 * keyword payload (callers paginate via `/api/clusters/[id]`).
 *
 *   {
 *     brands: [
 *       {
 *         id, topic, topic_slug, source, auto_generated, description,
 *         children: [
 *           { id, topic, topic_slug, keyword_count, page_count, ... }
 *         ]
 *       }
 *     ]
 *   }
 *
 * POST /api/clusters
 * Body: {
 *   topic: string,           // required — display name
 *   level: 0 | 1,            // required — 0 = brand, 1 = sub-product
 *   parent_map_id?: string,  // required when level=1
 *   description?: string,
 *   site?: string,
 * }
 *
 * Used by the manual-create UI ("New brand cluster" / "Add sub-product").
 * Auto-sets source='manual', auto_generated=false.
 */

export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req)
  const db = createServiceClient()

  // Pull brand maps + sub maps. Two queries is cheaper than the join — RLS
  // adds no overhead since we use the service client.
  const { data: maps, error: mapsErr } = await db
    .from('keyword_maps')
    .select('id, topic, topic_slug, level, parent_map_id, source, auto_generated, description, status, created_at, updated_at')
    .eq('owner_user_id', ownerId)
    .eq('site_slug', siteSlug)
    .order('topic', { ascending: true })

  if (mapsErr) return NextResponse.json({ error: mapsErr.message }, { status: 500 })

  const subIds = (maps ?? []).filter(m => m.level === 1).map(m => m.id)

  // Keyword & page counts per sub-product (only level-1 carries keywords).
  // Use head:true counts for speed (one round-trip each).
  const [{ data: keywordCounts }, { data: pageCounts }] = await Promise.all([
    subIds.length
      ? db.from('keyword_map_clusters').select('map_id').in('map_id', subIds)
      : Promise.resolve({ data: [] as { map_id: string }[] }),
    subIds.length
      ? db.from('cluster_pages').select('cluster_id').in('cluster_id', subIds)
      : Promise.resolve({ data: [] as { cluster_id: string }[] }),
  ])

  const kwBySub = new Map<string, number>()
  for (const r of (keywordCounts ?? []) as { map_id: string }[]) {
    kwBySub.set(r.map_id, (kwBySub.get(r.map_id) ?? 0) + 1)
  }
  const pgBySub = new Map<string, number>()
  for (const r of (pageCounts ?? []) as { cluster_id: string }[]) {
    pgBySub.set(r.cluster_id, (pgBySub.get(r.cluster_id) ?? 0) + 1)
  }

  interface MapNode {
    id:             string
    topic:          string
    topic_slug:     string
    level:          number
    parent_map_id:  string | null
    source:         string
    auto_generated: boolean
    description:    string | null
    status:         string | null
    created_at:     string
    updated_at:     string | null
    keyword_count:  number
    page_count:     number
    children:       MapNode[]
  }

  const allMaps = (maps ?? []) as Array<{
    id: string; topic: string; topic_slug: string; level: number
    parent_map_id: string | null; source: string; auto_generated: boolean
    description: string | null; status: string | null
    created_at: string; updated_at: string | null
  }>

  const brands: MapNode[] = []
  const subsByParent = new Map<string, MapNode[]>()

  for (const m of allMaps) {
    const node: MapNode = {
      id:             m.id,
      topic:          m.topic,
      topic_slug:     m.topic_slug,
      level:          m.level,
      parent_map_id:  m.parent_map_id,
      source:         m.source,
      auto_generated: m.auto_generated,
      description:    m.description,
      status:         m.status,
      created_at:     m.created_at,
      updated_at:     m.updated_at,
      keyword_count:  kwBySub.get(m.id) ?? 0,
      page_count:     pgBySub.get(m.id) ?? 0,
      children:       [],
    }
    if (m.level === 0) {
      brands.push(node)
    } else if (m.parent_map_id) {
      const arr = subsByParent.get(m.parent_map_id) ?? []
      arr.push(node)
      subsByParent.set(m.parent_map_id, arr)
    }
  }

  for (const b of brands) {
    b.children = (subsByParent.get(b.id) ?? []).sort((a, c) => a.topic.localeCompare(c.topic))
    // Roll up counts so the brand row shows totals across all sub-products
    b.keyword_count = b.children.reduce((s, c) => s + c.keyword_count, 0)
    b.page_count    = b.children.reduce((s, c) => s + c.page_count, 0)
  }

  // Brands without a level-1 child (legacy / freshly created) still appear.
  return NextResponse.json({
    brands: brands.sort((a, b) => a.topic.localeCompare(b.topic)),
  })
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const { topic, level, parent_map_id, description } = body as {
    topic?:         string
    level?:         number
    parent_map_id?: string
    description?:   string
  }

  if (!topic || (level !== 0 && level !== 1)) {
    return NextResponse.json({ error: 'topic and level (0|1) required' }, { status: 400 })
  }
  if (level === 1 && !parent_map_id) {
    return NextResponse.json({ error: 'parent_map_id required when level=1' }, { status: 400 })
  }

  const ownerId  = await getEffectiveOwnerId(supabase, user.id)
  const siteSlug = resolveSiteSlugFromRequest(req, body)
  const db = createServiceClient()

  // If level=1, validate parent belongs to the same owner+site
  if (level === 1) {
    const { data: parent } = await db
      .from('keyword_maps')
      .select('id, level, site_slug, owner_user_id')
      .eq('id', parent_map_id!)
      .maybeSingle()
    if (!parent) return NextResponse.json({ error: 'parent_map_id not found' }, { status: 404 })
    if (parent.level !== 0) return NextResponse.json({ error: 'parent must be a level-0 brand cluster' }, { status: 400 })
    if (parent.site_slug !== siteSlug || parent.owner_user_id !== ownerId) {
      return NextResponse.json({ error: 'parent does not belong to this site/owner' }, { status: 403 })
    }
  }

  const { data, error } = await db
    .from('keyword_maps')
    .insert({
      owner_user_id:  ownerId,
      site_slug:      siteSlug,
      topic,
      topic_slug:     slugify(topic),
      level,
      parent_map_id:  level === 1 ? parent_map_id : null,
      auto_generated: false,
      source:         'manual',
      description:    description ?? null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'A cluster with this name already exists at this level.' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ cluster: data })
}
