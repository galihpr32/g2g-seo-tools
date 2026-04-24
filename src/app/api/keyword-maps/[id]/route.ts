import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

// ── GET — single map + clusters ───────────────────────────────────────────────
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id } = await params

  const { data: map } = await db
    .from('keyword_maps')
    .select('*')
    .eq('id', id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!map) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: clusters } = await db
    .from('keyword_map_clusters')
    .select('*')
    .eq('map_id', id)
    .order('priority_order')

  return NextResponse.json({ map, clusters: clusters ?? [] })
}

// ── PATCH — update map meta or cluster status/move ───────────────────────────
// Body options:
//   { aliases: string[] }               — update map aliases
//   { status: string }                  — update map status
//   { cluster_id, status }              — update cluster status
//   { cluster_id, move_to_map_id }      — move cluster to another map
//   { cluster_id, cluster_group }       — rename cluster group
//   { cluster_id, priority_order }      — reorder cluster
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id } = await params
  const body = await req.json().catch(() => ({}))

  // Move cluster to another map
  if (body.cluster_id && body.move_to_map_id) {
    // Verify the destination map belongs to this owner
    const { data: destMap } = await db
      .from('keyword_maps')
      .select('id')
      .eq('id', body.move_to_map_id)
      .eq('owner_user_id', ownerId)
      .single()

    if (!destMap) return NextResponse.json({ error: 'Destination map not found' }, { status: 404 })

    const { error } = await db
      .from('keyword_map_clusters')
      .update({ map_id: body.move_to_map_id, cluster_group: body.cluster_group ?? null })
      .eq('id', body.cluster_id)
      .eq('owner_user_id', ownerId)

    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'Keyword already exists in the destination map' }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  // Update cluster fields
  if (body.cluster_id) {
    const updates: Record<string, unknown> = {}
    if (body.status         != null) updates.status         = body.status
    if (body.cluster_group  != null) updates.cluster_group  = body.cluster_group
    if (body.priority_order != null) updates.priority_order = body.priority_order
    if (body.suggested_title != null) updates.suggested_title = body.suggested_title
    if (body.url_slug       != null) updates.url_slug       = body.url_slug

    const { error } = await db
      .from('keyword_map_clusters')
      .update(updates)
      .eq('id', body.cluster_id)
      .eq('owner_user_id', ownerId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Update map meta
  const mapUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.aliases != null) mapUpdates.aliases = body.aliases
  if (body.status  != null) mapUpdates.status  = body.status
  if (body.topic   != null) mapUpdates.topic   = body.topic

  const { error } = await db
    .from('keyword_maps')
    .update(mapUpdates)
    .eq('id', id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── DELETE — remove map (cascades clusters) ───────────────────────────────────
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id } = await params

  await db.from('keyword_maps').delete().eq('id', id).eq('owner_user_id', ownerId)
  return NextResponse.json({ ok: true })
}
