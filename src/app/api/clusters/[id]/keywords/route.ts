import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST   /api/clusters/[id]/keywords
 *   body: { keyword: string, search_volume?: number, intent?: string, content_type?: string, source?: string }
 *
 * DELETE /api/clusters/[id]/keywords?keyword=<text>
 *   removes a single keyword from a level-1 cluster.
 *
 * Both routes only operate on level-1 (sub-product) clusters — keywords
 * never live on a brand-level (level-0) row in the new hierarchy.
 */

async function loadOwnedLeafCluster(db: ReturnType<typeof createServiceClient>, id: string, ownerId: string) {
  const { data } = await db
    .from('keyword_maps')
    .select('id, owner_user_id, level')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.owner_user_id !== ownerId) return { error: 'Not found', status: 404 } as const
  if (data.level !== 1) return { error: 'Keywords only live on sub-product (level-1) clusters', status: 400 } as const
  return { data } as const
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : ''
  if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 })

  const db = createServiceClient()
  const guard = await loadOwnedLeafCluster(db, id, ownerId)
  if ('error' in guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const { data, error } = await db
    .from('keyword_map_clusters')
    .insert({
      map_id:        id,
      owner_user_id: ownerId,
      keyword,
      search_volume: typeof body.search_volume === 'number' ? body.search_volume : null,
      intent:        typeof body.intent === 'string' ? body.intent : null,
      content_type:  typeof body.content_type === 'string' ? body.content_type : null,
      source:        typeof body.source === 'string' ? body.source : 'manual',
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Keyword already in this cluster' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ keyword: data })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()

  const guard = await loadOwnedLeafCluster(db, id, ownerId)
  if ('error' in guard) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const url = new URL(req.url)
  const keyword = url.searchParams.get('keyword')
  if (!keyword) return NextResponse.json({ error: 'keyword query param required' }, { status: 400 })

  const { error } = await db
    .from('keyword_map_clusters')
    .delete()
    .eq('map_id', id)
    .eq('owner_user_id', ownerId)
    .eq('keyword', keyword)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
