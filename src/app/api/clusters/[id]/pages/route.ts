import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

/**
 * POST   /api/clusters/[id]/pages
 *   body: { page_url: string, role?: 'pillar' | 'spoke' | 'category', notes?: string }
 *
 * DELETE /api/clusters/[id]/pages?page_url=<encoded>
 */

const VALID_ROLES = ['pillar', 'spoke', 'category'] as const

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const body = await req.json().catch(() => ({})) as Record<string, unknown>

  const pageUrl = typeof body.page_url === 'string' ? body.page_url.trim() : ''
  if (!pageUrl) return NextResponse.json({ error: 'page_url required' }, { status: 400 })

  const role = typeof body.role === 'string' && (VALID_ROLES as readonly string[]).includes(body.role) ? body.role : 'spoke'

  const db = createServiceClient()

  // Validate cluster exists + belongs to owner; lift site_slug for the new row.
  const { data: cluster } = await db
    .from('keyword_maps')
    .select('id, owner_user_id, site_slug')
    .eq('id', id)
    .maybeSingle()
  if (!cluster || cluster.owner_user_id !== ownerId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const { data, error } = await db
    .from('cluster_pages')
    .insert({
      cluster_id:    id,
      owner_user_id: ownerId,
      site_slug:     cluster.site_slug,
      page_url:      pageUrl,
      role,
      notes:         typeof body.notes === 'string' ? body.notes : null,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'Page already linked to this cluster' }, { status: 409 })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ page: data })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const url = new URL(req.url)
  const pageUrl = url.searchParams.get('page_url')
  if (!pageUrl) return NextResponse.json({ error: 'page_url query param required' }, { status: 400 })

  const db = createServiceClient()
  const { error } = await db
    .from('cluster_pages')
    .delete()
    .eq('cluster_id', id)
    .eq('owner_user_id', ownerId)
    .eq('page_url', pageUrl)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
