import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getEffectiveOwnerId } from '@/lib/workspace'

type Params = { params: Promise<{ id: string }> }

// ── POST /api/campaigns/[id]/pages — add a page to campaign ─────────────────
// Body: { page_url, action_item_id? }
export async function POST(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id: campaign_id } = await params

  // Verify campaign belongs to owner
  const { data: campaign } = await db
    .from('campaigns')
    .select('id')
    .eq('id', campaign_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })

  const body = await request.json() as { page_url: string; action_item_id?: string }

  if (!body.page_url?.trim()) {
    return NextResponse.json({ error: 'page_url is required' }, { status: 400 })
  }

  // Normalise URL
  let url = body.page_url.trim()
  if (!url.startsWith('http')) url = 'https://' + url

  // Position at end
  const { count } = await db
    .from('campaign_pages')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign_id)

  const { data: page, error } = await db
    .from('campaign_pages')
    .insert({
      campaign_id,
      owner_user_id:  ownerId,
      page_url:       url,
      action_item_id: body.action_item_id ?? null,
      position:       count ?? 0,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Page already in this campaign' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ page })
}

// ── DELETE /api/campaigns/[id]/pages — remove a page from campaign ────────────
// Body: { page_id }
export async function DELETE(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const db = createServiceClient()
  const { id: campaign_id } = await params

  const { page_id } = await request.json() as { page_id: string }

  const { error } = await db
    .from('campaign_pages')
    .delete()
    .eq('id', page_id)
    .eq('campaign_id', campaign_id)
    .eq('owner_user_id', ownerId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

// ── PATCH /api/campaigns/[id]/pages — move page to different campaign ─────────
// Body: { page_id, target_campaign_id, position? }
export async function PATCH(request: Request, { params }: Params) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ownerId = await getEffectiveOwnerId(supabase, user.id)
  const { id: source_campaign_id } = await params

  const body = await request.json() as {
    page_id: string
    target_campaign_id: string
    position?: number
  }

  // Verify target campaign belongs to owner
  const { data: target } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', body.target_campaign_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!target) return NextResponse.json({ error: 'Target campaign not found' }, { status: 404 })

  // Get the page's url first (to re-insert if moving to different campaign)
  const { data: existing } = await supabase
    .from('campaign_pages')
    .select('page_url, action_item_id')
    .eq('id', body.page_id)
    .eq('campaign_id', source_campaign_id)
    .eq('owner_user_id', ownerId)
    .single()

  if (!existing) return NextResponse.json({ error: 'Page not found' }, { status: 404 })

  if (source_campaign_id === body.target_campaign_id) {
    // Same column reorder — just update position
    const { error } = await supabase
      .from('campaign_pages')
      .update({ position: body.position ?? 0 })
      .eq('id', body.page_id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    // Move to different column: delete from source, insert into target
    await supabase
      .from('campaign_pages')
      .delete()
      .eq('id', body.page_id)

    const { count } = await supabase
      .from('campaign_pages')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', body.target_campaign_id)

    const { error } = await supabase
      .from('campaign_pages')
      .insert({
        campaign_id:    body.target_campaign_id,
        owner_user_id:  ownerId,
        page_url:       existing.page_url,
        action_item_id: existing.action_item_id,
        position:       body.position ?? (count ?? 0),
      })

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'Page already in target campaign' }, { status: 409 })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true })
}
